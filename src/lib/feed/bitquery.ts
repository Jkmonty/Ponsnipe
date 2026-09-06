/**
 * Pons launches pushed over Bitquery's WebSocket, rather than polled.
 *
 * This runs *alongside* the RPC sweep, not instead of it, and that is
 * deliberate. The sweep is the thing that has been measured — 99.9% of launches
 * captured against the chain — and it needs no third party, no key and no
 * subscription. Bitquery's value here is latency: a push arrives when the block
 * does, where a poll waits up to its interval. Whichever sees a launch first
 * enters it; the other finds it already indexed and does nothing.
 *
 * So a dead token, an expired plan or a dropped socket costs latency and
 * nothing else. That is the only arrangement worth having for a paid dependency
 * on a feed that already works.
 *
 * Protocol is graphql-transport-ws: connection_init, wait for connection_ack,
 * then subscribe. Node 22+ has WebSocket built in, so there is no client
 * library involved.
 */
import { getAddress, type Address } from "viem";
import { logEngine } from "../db/index";
import { PONS } from "../pons/addresses";
import { ingestLaunches, type RawLaunch } from "./market";

const WS_URL = "wss://streaming.bitquery.io/graphql";
const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
/** No traffic for this long and the socket is presumed dead. */
const IDLE_TIMEOUT_MS = 90_000;

/**
 * Events rather than Calls: the decoded TokenLaunched arguments are exactly the
 * fields the ingest path wants, where a raw Call would have to be ABI-decoded
 * here to get the same thing.
 */
const SUBSCRIPTION = `
subscription {
  EVM(network: robinhood) {
    Events(
      where: {
        LogHeader: { Address: { is: "${PONS.factory.toLowerCase()}" } }
        Log: { Signature: { Name: { is: "TokenLaunched" } } }
      }
    ) {
      Block { Number Time }
      Transaction { Hash From }
      Arguments {
        Name
        Value {
          ... on EVM_ABI_Address_Value_Arg { address }
          ... on EVM_ABI_BigInt_Value_Arg { bigInteger }
          ... on EVM_ABI_Integer_Value_Arg { integer }
        }
      }
    }
  }
}`;

interface BqState {
  running: boolean;
  ws: WebSocket | undefined;
  connected: boolean;
  received: number;
  ingested: number;
  attempts: number;
  lastError: string | null;
  lastEventAt: number;
  reconnect: ReturnType<typeof setTimeout> | undefined;
  idle: ReturnType<typeof setInterval> | undefined;
}

const g = globalThis as typeof globalThis & { __ponsBitquery?: BqState };
const s: BqState =
  g.__ponsBitquery ??
  (g.__ponsBitquery = {
    running: false,
    ws: undefined,
    connected: false,
    received: 0,
    ingested: 0,
    attempts: 0,
    lastError: null,
    lastEventAt: 0,
    reconnect: undefined,
    idle: undefined,
  });

const token = () => process.env.BITQUERY_TOKEN?.trim() ?? "";

export function bitqueryConfigured(): boolean {
  return token().length > 0;
}

interface ArgValue {
  address?: string;
  bigInteger?: string | number;
  integer?: string | number;
}
interface EventArg {
  Name?: string;
  Value?: ArgValue;
}

/** Decoded TokenLaunched arguments -> the shape the ingest path takes. */
function toLaunch(ev: Record<string, unknown>): RawLaunch | null {
  const args = (ev.Arguments as EventArg[] | undefined) ?? [];
  const by = new Map<string, ArgValue>();
  for (const a of args) if (a?.Name) by.set(a.Name, a.Value ?? {});

  const addr = (k: string): Address | null => {
    const v = by.get(k)?.address;
    try {
      return v ? getAddress(v) : null;
    } catch {
      return null;
    }
  };
  const token = addr("token");
  const curve = addr("curve");
  if (!token || !curve) return null;

  const big = (k: string): bigint => {
    const v = by.get(k);
    const raw = v?.bigInteger ?? v?.integer;
    try {
      return raw === undefined ? 0n : BigInt(String(raw));
    } catch {
      return 0n;
    }
  };
  const block = (ev.Block as { Number?: string | number } | undefined)?.Number;

  return {
    token,
    curve,
    deployer: addr("deployer") ?? ("0x0000000000000000000000000000000000000000" as Address),
    pairToken: addr("pairToken") ?? ("0x0000000000000000000000000000000000000000" as Address),
    threshold: big("graduationThreshold"),
    block: block === undefined ? 0n : BigInt(String(block)),
  };
}

function scheduleReconnect(): void {
  if (!s.running || s.reconnect) return;
  // Backs off to a minute so an expired token or a dead plan does not hammer
  // them, and recovers quickly from an ordinary dropped socket.
  const wait = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(5, s.attempts));
  s.reconnect = setTimeout(() => {
    s.reconnect = undefined;
    connect();
  }, wait);
  if (s.reconnect && typeof s.reconnect === "object" && "unref" in s.reconnect) s.reconnect.unref();
}

function connect(): void {
  if (!s.running || !bitqueryConfigured()) return;
  s.attempts += 1;

  let ws: WebSocket;
  try {
    // The token goes in the query string because the browser-standard
    // WebSocket has no way to set an Authorization header on the handshake.
    ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token())}`, "graphql-transport-ws");
  } catch (err) {
    s.lastError = String(err).slice(0, 160);
    scheduleReconnect();
    return;
  }
  s.ws = ws;

  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ type: "connection_init", payload: {} }));
  });

  ws.addEventListener("message", (e: MessageEvent) => {
    s.lastEventAt = Date.now();
    let msg: { type?: string; payload?: unknown };
    try {
      msg = JSON.parse(String(e.data));
    } catch {
      return;
    }

    if (msg.type === "connection_ack") {
      s.connected = true;
      s.attempts = 0;
      s.lastError = null;
      ws.send(JSON.stringify({ id: "pons-launches", type: "subscribe", payload: { query: SUBSCRIPTION } }));
      logEngine("info", "bitquery: subscribed to pons TokenLaunched");
      return;
    }
    if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    }
    if (msg.type === "error") {
      s.lastError = JSON.stringify(msg.payload).slice(0, 200);
      logEngine("warn", `bitquery error: ${s.lastError}`);
      return;
    }
    if (msg.type !== "next") return;

    const evs = (msg.payload as { data?: { EVM?: { Events?: Record<string, unknown>[] } } })?.data?.EVM?.Events;
    if (!Array.isArray(evs) || !evs.length) return;
    s.received += evs.length;

    const launches = evs.map(toLaunch).filter((x): x is RawLaunch => x !== null);
    if (!launches.length) return;
    // Fire and forget: a push must never block the socket on RPC enrichment.
    void ingestLaunches(launches, launches[0].block)
      .then((n) => {
        s.ingested += n;
      })
      .catch((err) => {
        s.lastError = String(err).slice(0, 160);
      });
  });

  ws.addEventListener("close", (e: CloseEvent) => {
    s.connected = false;
    if (s.running) {
      s.lastError = `socket closed (${e.code})`;
      scheduleReconnect();
    }
  });

  ws.addEventListener("error", () => {
    s.connected = false;
    s.lastError = "socket error";
  });
}

export function startBitquery(): void {
  if (s.running) return;
  if (!bitqueryConfigured()) return;
  s.running = true;
  s.lastEventAt = Date.now();
  connect();

  // A socket can stop delivering without closing, which looks exactly like a
  // quiet chain — the same failure the sniper's watcher had. Reconnect if
  // nothing at all arrives for a while.
  s.idle = setInterval(() => {
    if (!s.running || !s.connected) return;
    if (Date.now() - s.lastEventAt < IDLE_TIMEOUT_MS) return;
    logEngine("warn", "bitquery: no traffic, reconnecting");
    try {
      s.ws?.close();
    } catch {
      /* already gone */
    }
  }, 30_000);
  if (s.idle && typeof s.idle === "object" && "unref" in s.idle) s.idle.unref();

  logEngine("info", "bitquery launch stream started");
}

export function stopBitquery(): void {
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
  s.connected = false;
}

export function bitqueryStatus() {
  return {
    configured: bitqueryConfigured(),
    running: s.running,
    connected: s.connected,
    received: s.received,
    /** Launches this stream indexed before the polling sweep reached them. */
    ingested: s.ingested,
    lastError: s.lastError,
  };
}
