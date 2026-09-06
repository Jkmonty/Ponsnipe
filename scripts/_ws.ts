process.loadEnvFile?.(".env");
import { PONS } from "../src/lib/pons/addresses";
const CANDIDATES = [
  "wss://rpc.mainnet.chain.robinhood.com",
  "wss://rpc.mainnet.chain.robinhood.com/ws",
  "wss://ws.mainnet.chain.robinhood.com",
  "wss://rpc.robinhoodchain.com/ws",
];
// keccak256("TokenLaunched(address,address,address,address,uint256,uint256)")
const TOPIC = "0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607";
const out: string[] = [];
function probe(url: string): Promise<string> {
  return new Promise((resolve) => {
    let ws: WebSocket;
    const done = (m: string) => { try { ws?.close(); } catch {} resolve(m); };
    const t = setTimeout(() => done("timeout"), 9000);
    try { ws = new WebSocket(url); } catch (e) { clearTimeout(t); return resolve("cannot open: " + String(e).slice(0,40)); }
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ jsonrpc:"2.0", id:1, method:"eth_subscribe",
        params:["logs", { address: PONS.factory, topics: [TOPIC] }] }));
    });
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(String((e as MessageEvent).data));
      if (m.id === 1) {
        clearTimeout(t);
        if (m.error) return done("eth_subscribe REFUSED: " + JSON.stringify(m.error).slice(0,80));
        return done("SUBSCRIBED ok (id " + String(m.result).slice(0,12) + ")");
      }
    });
    ws.addEventListener("error", () => { clearTimeout(t); done("connection error"); });
    ws.addEventListener("close", (e) => { clearTimeout(t); done(`closed (${(e as CloseEvent).code})`); });
  });
}
async function main() {
  for (const u of CANDIDATES) out.push(`  ${u.padEnd(46)} -> ${await probe(u)}`);
}
main().then(()=>console.log(out.join("\n"))).catch(e=>console.log("ERR",String(e).slice(0,120)));
