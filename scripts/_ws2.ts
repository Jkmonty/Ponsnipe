process.loadEnvFile?.(".env");
import { PONS } from "../src/lib/pons/addresses";
const TOPIC = "0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607";
const out: string[] = [];
function probe(url: string, seconds = 25): Promise<void> {
  return new Promise((resolve) => {
    let ws: WebSocket;
    let subbed = false, events = 0;
    const t0 = Date.now();
    const fin = (m: string) => { out.push(`  ${m}`); try{ws?.close();}catch{} resolve(); };
    const timer = setTimeout(() => fin(subbed ? `stream alive: ${events} launches in ${seconds}s` : "no subscribe ack"), seconds*1000);
    try { ws = new WebSocket(url); } catch (e) { clearTimeout(timer); return fin("cannot open: "+String(e).slice(0,50)); }
    ws.addEventListener("open", () => {
      out.push("  connected");
      ws.send(JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_subscribe",params:["logs",{address:PONS.factory,topics:[TOPIC]}]}));
    });
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(String((e as MessageEvent).data));
      if (m.id === 1) {
        if (m.error) { clearTimeout(timer); return fin("eth_subscribe REFUSED: "+JSON.stringify(m.error).slice(0,90)); }
        subbed = true; out.push("  subscribed to TokenLaunched, listening…");
      }
      if (m.method === "eth_subscription") {
        events++;
        const blk = parseInt(m.params?.result?.blockNumber ?? "0x0", 16);
        if (events <= 5) out.push(`    launch at block ${blk}  (+${((Date.now()-t0)/1000).toFixed(1)}s)`);
      }
    });
    ws.addEventListener("error", () => { clearTimeout(timer); fin("connection error"); });
    ws.addEventListener("close", (e) => { clearTimeout(timer); if(!subbed) fin(`closed (${(e as CloseEvent).code})`); });
  });
}
async function main(){ out.push("wss://robinhood-rpc.publicnode.com"); await probe("wss://robinhood-rpc.publicnode.com"); }
main().then(()=>console.log(out.join("\n"))).catch(e=>console.log("ERR",String(e).slice(0,120)));
