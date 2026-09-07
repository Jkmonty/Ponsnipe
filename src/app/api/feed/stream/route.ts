import { feedSubscribers } from "@/lib/feed/market";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Tells an open feed the moment a launch is indexed.
 *
 * The browser polled every two seconds, so a coin indexed in 0.09s could sit
 * unseen for up to another two — by far the largest delay left in the path,
 * and all of it after the difficult part was finished. This carries no data:
 * it says "something landed" and the client fetches, which keeps one copy of
 * the query, the USD conversion and the ordering rather than growing a second
 * one here that could disagree with it.
 *
 * The client keeps a slow poll running underneath. If this connection dies,
 * is refused by a proxy, or is never established at all, the feed gets slower
 * and stays correct.
 */
export async function GET(req: Request) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let open = true;
      const send = (line: string) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(line));
        } catch {
          open = false;
        }
      };

      const onLaunch = (n: number) => send(`data: ${JSON.stringify({ launches: n })}\n\n`);
      feedSubscribers().add(onLaunch);

      // An opening comment flushes headers, so the browser reports the
      // connection as open rather than waiting for the first launch.
      send(": connected\n\n");

      /*
       * A heartbeat, because a silent connection is indistinguishable from a
       * dead one to every proxy between here and the browser, and they time it
       * out. Launches arrive every few seconds so this rarely fires, but it is
       * what keeps a quiet spell from being mistaken for a hang.
       */
      const beat = setInterval(() => send(": ping\n\n"), 20_000);
      if (typeof beat === "object" && "unref" in beat) beat.unref();

      const close = () => {
        open = false;
        clearInterval(beat);
        feedSubscribers().delete(onLaunch);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      // Unsubscribe when the tab goes away, or every closed tab leaks a
      // listener that the sweep keeps calling for the life of the process.
      req.signal.addEventListener("abort", close);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Nginx and friends buffer streamed responses by default, which would
      // hold every event until the buffer filled.
      "x-accel-buffering": "no",
    },
  });
}
