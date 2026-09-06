/**
 * Launches pushed over a WebSocket, instead of waiting for the next poll.
 *
 * The public RPC we sweep has no WebSocket, which is why this app polled at all
 * — but publicnode runs one for this chain that accepts eth_subscribe on logs,
 * free and without a key. Subscribing to TokenLaunched on the pons factory
 * means a launch arrives when its block does, rather than up to a poll interval
 * later.
 *
 * It runs *alongside* the sweep, never instead of it. The sweep is the measured
 * thing — 99.9% of launches captured — and it is what survives this socket
 * being down, rate-limited or quietly dead. Whichever source sees a launch
 * first indexes it; the other finds it already known and does nothing. So the
 * worst this can do is stop helping.
 */
import { decodeEventLog, parseAbiItem, getAddress, type Address } from "viem";
import { logEngine } from "../db/index";
import { PONS } from "../pons/addresses";
import { ingestLaunches, type RawLaunch } from "./market";

const LAUNCH_EVENT = parseAbiItem(
  "event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)",
);
/** keccak256 of the TokenLaunched signature, as the node wants it. */
const TOPIC = "0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607";

const WS_URL = process.env.LAUNCH_WS_URL?.trim() || "wss://robinhood-rpc.publicnode.com";
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/**
 * A socket can stop delivering without closing, which looks exactly like a
 * quiet chain — the failure that left the sniper blind for two hours. Launches
 * arrive every few seconds here, so silence this long means it is dead.
 */
const IDLE_TIMEOUT_MS = 120_000;

interface StreamState {
  running: boolean;
  ws: WebSocket | undefined;
  subscribed: boolean;
  received: number;
  ingested: number;
  attempts: number;
  lastError: string | null;
  lastEventAt: number;
  reconnect: ReturnType<typeof setTimeout> | undefined;
  idle: ReturnType<typeof setInterval> | undefined;
}

const g = globalThis as typeof globalThis & { __ponsLaunchStream?: StreamState };
const s: StreamState =
  g.__ponsLaunchStream ??
  (g.__ponsLaunchStream = {
    running: false,
    ws: undefined,
    subscribed: false,
    received: 0,
    ingested: 0,
    attempts: 0,
    lastError: null,
    lastEventAt: 0,
    reconnect: undefined,
    idle: undefined,
  });

interface RpcLog {
  address?: string;
  topics?: string[];
  data?: string;
  blockNumber?: string;
  logIndex?: string;
}

function toLaunch(log: RpcLog): RawLaunch | null {
  try {
    const { args } = decodeEventLog({
      abi: [LAUNCH_EVENT],
      data: (log.data ?? "0x") as `0x${string}`,
      topics: (log.topics ?? []) as [`0x${string}`, ...`0x${string}`[]],
    });
    const a = args as unknown as {
      token: Address;
      curve: Address;
      deployer: Address;
      pairToken: Address;
      graduationThreshold: bigint;
    };
    return {
      token: getAddress(a.token),
      curve: getAddress(a.curve),
      deployer: getAddress(a.deployer),
      pairToken: getAddress(a.pairToken),
      threshold: a.graduationThreshold ?? 0n,
      block: BigInt(log.blockNumber ?? "0x0"),
      logIndex: Number(BigInt(log.logIndex ?? "0x0")),
    };
  } catch {
    return null;
  }
}

function scheduleReconnect(): void {
  if (!s.running || s.reconnect) return;
  const wait = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(5, s.attempts));
  s.reconnect = setTimeout(() => {
    s.reconnect = undefined;
    connect();
  }, wait);
  if (s.reconnect && typeof s.reconnect === "object" && "unref" in s.reconnect) s.reconnect.unref();
}

function connect(): void {
  if (!s.running) return;
  s.attempts += 1;
  s.subscribed = false;

  let ws: WebSocket;
  try {
    ws = new WebSocket(WS_URL);
  } catch (err) {
    s.lastError = String(err).slice(0, 140);
    scheduleReconnect();
    return;
  }
  s.ws = ws;

  ws.addEventListener("open", () => {
    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_subscribe",
        params: ["logs", { address: PONS.factory, topics: [TOPIC] }],
      }),
    );
  });

  ws.addEventListener("message", (e) => {
    s.lastEventAt = Date.now();
    let m: { id?: number; error?: unknown; method?: string; params?: { result?: RpcLog } };
    try {
      m = JSON.parse(String((e as MessageEvent).data));
    } catch {
      return;
    }

    if (m.id === 1) {
      if (m.error) {
        s.lastError = `eth_subscribe refused: ${JSON.stringify(m.error).slice(0, 120)}`;
        logEngine("warn", `launch stream: ${s.lastError}`);
        try {
          ws.close();
        } catch {
          /* already gone */
        }
        return;
      }
      s.subscribed = true;
      s.attempts = 0;
      s.lastError = null;
      logEngine("info", `launch stream subscribed (${WS_URL})`);
      return;
    }

    if (m.method !== "eth_subscription") return;
    const log = m.params?.result;
    if (!log) return;
    s.received += 1;

    const launch = toLaunch(log);
    if (!launch) return;
    // Fire and forget: enrichment does RPC work and must not block the socket.
    void ingestLaunches([launch], launch.block)
      .then((n) => {
        s.ingested += n;
      })
      .catch((err) => {
        s.lastError = String(err).slice(0, 140);
      });
  });

  ws.addEventListener("error", () => {
    s.subscribed = false;
    s.lastError = "socket error";
  });

  ws.addEventListener("close", (e) => {
    s.subscribed = false;
    if (s.running) {
      s.lastError = `socket closed (${(e as CloseEvent).code})`;
      scheduleReconnect();
    }
  });
}

export function startLaunchStream(): void {
  if (s.running) return;
  s.running = true;
  s.lastEventAt = Date.now();
  connect();

  s.idle = setInterval(() => {
    if (!s.running || !s.subscribed) return;
    if (Date.now() - s.lastEventAt < IDLE_TIMEOUT_MS) return;
    logEngine("warn", "launch stream: silent, reconnecting");
    try {
      s.ws?.close();
    } catch {
      /* already gone */
    }
  }, 30_000);
  if (s.idle && typeof s.idle === "object" && "unref" in s.idle) s.idle.unref();
}

export function stopLaunchStream(): void {
  s.running = false;
  if (s.reconnect) clearTimeout(s.reconnect);
  if (s.idle) clearInterval(s.idle);
  s.reconnect = undefined;
  s.idle = undefined;
  try {
    s.ws?.close();
  } catch {
    /* already gone */
  }
  s.subscribed = false;
}

export function launchStreamStatus() {
  return {
    running: s.running,
    subscribed: s.subscribed,
    received: s.received,
    /** Launches this stream indexed before the polling sweep reached them. */
    ingested: s.ingested,
    lastError: s.lastError,
  };
}
