import * as T from "three";
import type { Stock } from "./world";
import { rand } from "./scene";

export interface Butt {
  group: T.Group;
  stock: Stock;
  hostile: boolean;
  /** The disc that gets shot. Raycasting against the whole group would let a
      post or a leg count as a hit. */
  face: T.Mesh;
  lane: number;
  x: number;
  vx: number;
  out: number;
  rising: boolean;
  dwell: number;
  cooldown: number;
  dead: number;
}

/** Where the three rows of cover sit, in world units away from the camera. */
export const LANES = [-12, -25, -38];
/** How near an arrow has to pass to count. Generous: this is an arcade. */
export const HIT_RADIUS = 2.6;

/**
 * The ticker, drawn to a texture.
 *
 * A canvas texture rather than a font loader: it needs one short string per
 * target, and shipping a typeface to render six characters would cost more
 * than the rest of the wood put together.
 */
/**
 * The face of a butt: an archery roundel with the ticker across it.
 *
 * It was a rectangle stretched onto a disc, which cropped the rings off and
 * left a pale smudge that vanished against the trees. Concentric rings in
 * the stock's own colour read as a target at any distance, and say which
 * way the share is going before the letters are legible — which matters,
 * because the red ones shoot back.
 */
export function tickerLabel(text: string, colour: string): T.Texture {
  const S = 256;
  const cv = document.createElement("canvas");
  cv.width = S;
  cv.height = S;
  const c = cv.getContext("2d")!;
  const rings: [number, string][] = [
    [126, colour],
    [104, "#f4edda"],
    [82, colour],
    [60, "#f4edda"],
    [34, "#e8b54a"],
  ];
  for (const [r, fill] of rings) {
    c.beginPath();
    c.arc(S / 2, S / 2, r, 0, Math.PI * 2);
    c.fillStyle = fill;
    c.fill();
  }
  // A band behind the letters, so the ticker survives the rings under it.
  c.fillStyle = "rgba(12, 18, 24, 0.82)";
  c.fillRect(0, 104, S, 48);
  c.fillStyle = "#f8f4e6";
  c.font = "bold 42px ui-monospace, SFMono-Regular, monospace";
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.fillText(text.slice(0, 6), S / 2, 129);
  const tex = new T.CanvasTexture(cv);
  tex.colorSpace = T.SRGBColorSpace;
  return tex;
}

/**
 * A butt raised at a decided stock, lane and x. The caller has already
 * decided which stock is up, which lane it rises in and where along that
 * lane it sits; this builds the group and the rest of the state that goes
 * with it.
 */
export function makeButt(stock: Stock, lane: number, x: number): Butt {
  const hostile = stock.changePct < 0;
  const z = LANES[lane];
  const group = new T.Group();

  const ringColour = hostile ? "#ff5d5d" : "#7ae089";
  // The butt: a straw roundel on a post, facing the shooter.
  const face = new T.Mesh(
    new T.CircleGeometry(3.4, 22),
    // Unlit: a target you cannot read is not a target, and the range is
    // lit for dusk. Both sides, so one that spawns turned slightly away is
    // still something to shoot rather than an invisible edge.
    new T.MeshBasicMaterial({
      map: tickerLabel(stock.symbol, ringColour),
      side: T.DoubleSide,
    }),
  );
  /*
   * High enough to clear the hedge it hides behind.
   *
   * At the old height the bottom half of every face sat inside the cover
   * permanently, so a target was a crescent you could not read the ticker
   * on. Cover should hide a butt while it is down and let it stand clear
   * when it is up — not crop it forever.
   */
  face.position.y = 5.2;
  group.add(face);

  const rim = new T.Mesh(
    new T.TorusGeometry(3.45, 0.24, 6, 24),
    new T.MeshLambertMaterial({ color: new T.Color(ringColour), flatShading: true }),
  );
  rim.position.y = 5.2;
  group.add(rim);

  const post = new T.Mesh(
    new T.CylinderGeometry(0.18, 0.24, 5.4, 5),
    new T.MeshLambertMaterial({ color: 0x4a3a28, flatShading: true }),
  );
  post.position.y = 2.7;
  group.add(post);

  group.position.set(x, -9, z);

  return {
    group,
    stock,
    hostile,
    face,
    lane,
    x,
    vx: (Math.random() < 0.5 ? 1 : -1) * rand(1.6, 4.2),
    out: 0,
    rising: true,
    /*
     * A red that never fires is scenery.
     *
     * The first shot was on a 0.6-1.3s timer while a butt stood up for only
     * 0.4-1.1s, so most of them sank back into cover without ever loosing —
     * which is why the reds seemed harmless. They now stand long enough to
     * shoot, and shoot soon enough to matter.
     */
    dwell: hostile ? rand(1.3, 2.4) : rand(0.5, 1.2),
    cooldown: hostile ? rand(0.25, 0.6) : rand(0.6, 1.3),
    dead: 0,
  };
}
