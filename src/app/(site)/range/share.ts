/**
 * The results image: one round, drawn on a canvas, 1200×675.
 *
 * This is the only part of the range that travels beyond the site, so it is
 * the one part that has to look composed rather than assembled. Nothing here
 * leaves the browser: the image is painted on a canvas the page owns and
 * handed straight to the player, so there is no upload, no route and no
 * network call — the spec's non-goals say exactly that.
 *
 * Like every other module in this phase, these are plain functions over the
 * data they are handed. `Run` below is what the results card already shows,
 * not `Snapshot` — the card hands over the numbers it prints rather than the
 * whole game state, and nothing here reaches back into `World`.
 *
 * `shareLines` and `shareText` are pure and unit-tested. `drawShare` is
 * verified in the browser, the same split the rest of the phase uses.
 */
import { accuracyPct } from "./world";
import { ringName } from "./butts";

/**
 * One finished round, as the results card shows it.
 *
 * Deliberately not `Snapshot`: this is the card's own view of the round —
 * six numbers it already has on screen — so `share.ts` has no opinion about
 * health, the clock, the wave or anything else the game tracks while it is
 * running.
 */
export interface Run {
  points: number;
  hits: number;
  shots: number;
  /** Longest run of hits without a miss. */
  streak: number;
  /** Best ring struck, 1 gold … 5 white; 0 if nothing was struck. */
  bestRing: number;
  /** The ticker that earned the most. Empty if the round landed no hits. */
  bestSymbol: string;
}

/** The image, in CSS pixels. 16:9 at the size X serves a large photo at. */
export const SHARE_W = 1200;
export const SHARE_H = 675;

/**
 * The lines printed under the score.
 *
 * The score itself is not one of these — `drawShare` sets it in the display
 * face at ten times this size, straight off `run.points`. These are the
 * spec's "the run's numbers under it, the best ticker", and they say the
 * same things the results card says, in the same order.
 *
 * Accuracy comes from `accuracyPct` rather than a second division written
 * here: a round can end with no shots fired, and the card that someone posts
 * is the very worst place to discover a NaN.
 */
export function shareLines(run: Run): string[] {
  const lines = [
    `${run.hits} hits from ${run.shots} shots · ${accuracyPct(run.hits, run.shots)}% accuracy`,
    `Longest streak ${run.streak} · best ring ${ringName(run.bestRing)}`,
  ];
  // Same rule the card uses: a round with no hits never set a best ticker,
  // so there is no line for one rather than an empty label.
  if (run.bestSymbol) lines.push(`Best ticker ${run.bestSymbol}`);
  return lines;
}

/**
 * The line offered alongside the image, for pasting into a post.
 *
 * Two rules from docs/POSTS.md govern every word of this. It says what the
 * round was, and it never implies a return — no winnings, no prize, no
 * invitation to make money. The site charges a trading fee and the board
 * pays a prize, so a line promising either is a liability rather than a
 * tone problem.
 *
 * It also names no ticker. The image can afford to print the best one
 * because the image is unmistakably a game — a painted archery range with a
 * score on it. This text can be pasted on its own, where a ticker beside a
 * large number reads as a tip.
 */
export function shareText(run: Run): string {
  return (
    `${run.points.toLocaleString("en-GB")} at the Sherwood Shooting Range — ` +
    `${run.hits} hits from ${run.shots} shots, ` +
    `${accuracyPct(run.hits, run.shots)}% accuracy. ponsnipe.com/range`
  );
}

/* ── the painted range ───────────────────────────────────────────────────
 *
 * A flat backdrop painted in canvas code, not a screenshot of the WebGL
 * scene: golden hour as flat bands, with the palisade and the butts as
 * silhouettes.
 *
 * The range's colours are `scene.ts`'s, because an image that does not look
 * like the game is worse than no image. They are arrived at two ways, and
 * each constant below says which:
 *
 *  - The sky is `scene.ts`'s own four stops and its own piecewise mix,
 *    reproduced exactly (see `skyAt`).
 *  - Everything lit — the ground, the trees, the palisade — has a screen
 *    colour that is the product of the sun, the ambient, the fog and ACES
 *    tone mapping. Rather than reimplement that chain, the frame was read
 *    back from the running renderer and sampled. Where a sample is used as
 *    it came off the screen it says so; where one was adjusted to work as a
 *    flat shape, it says that instead.
 */

/** The sky shader's four stops, from `scene.ts`'s `sky()`, unchanged. */
const SKY_TOP = 0x16243a;
const SKY_MID = 0x6b4a3a;
const SKY_HOT = 0xe08a3c;
const SKY_HORIZON = 0xf4b35a;

/**
 * The lit materials, off the screen rather than out of `scene.ts`.
 *
 * `scene.ts`'s hexes for these are the materials' own albedo, not what lands
 * on screen — the 0x2f5a3c ground under a 13° sun composites to very nearly
 * black, which is exactly why the range reads as silhouettes against an
 * orange band, and why reading these as a swatch would draw a different
 * game.
 */
/** Ground plane (albedo 0x2f5a3c), sampled as it came off the screen. */
const GROUND = "#010a03";
/** The conifer mass (albedo 0x2c5233). Not one sample: on screen the trees
    are a scatter of lit faces near rgb(83, 116, 47) and shadowed ones at the
    ground's own value, and a flat silhouette wants a single colour between
    the two. */
const TREE = "#06110a";
/** A palisade post's sunward face (albedo 0x4a3a28), sampled as it came off
    the screen. */
const STAKE_LIT = "#1f0c03";
/** The same post's shaded face, which samples at very nearly pure black and
    is lifted a little here so a stake reads as a shape rather than a hole. */
const STAKE_DARK = "#0a0401";
/** The fog, `scene.ts`'s `T.Fog(0xd8a367, …)`, used as the haze it makes. */
const HAZE = "216, 163, 103";
/** The sun, `scene.ts`'s `T.DirectionalLight(0xffd9a0, 2.4)`. */
const SUN = "255, 217, 160";

/** The site's own ink, from `site.css`. */
const INK = "#f2f5ee"; // .site .display
const MOSS = "#aeb9ab"; // --moss
const BARK = "#6f7d6c"; // --bark
const GOLD = "#f0b429"; // --gold
/** The card's own glass: `.site .arc-card`'s `rgba(8, 12, 9, 0.78)`, with the
    alpha chosen per gradient stop below rather than fixed at the card's. */
const VEIL = "8, 12, 9";

/** sRGB byte → the linear value the sky shader mixes in. */
function toLinear(b: number): number {
  const c = b / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearRgb(hex: number): [number, number, number] {
  return [toLinear((hex >> 16) & 255), toLinear((hex >> 8) & 255), toLinear(hex & 255)];
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * The sky at elevation `h`, where `h` is `sin(elevation)` — the same `vDir.y`
 * `scene.ts`'s fragment shader switches on, with the same three bands and the
 * same two smoothstep edges.
 *
 * The shader writes `gl_FragColor` directly, so it never passes through the
 * renderer's sRGB output transform: what lands on screen is the linear value
 * of each stop. That is why the stops are linearised here and mixed in that
 * space rather than mixed as hex.
 *
 * Checked by reading the composited frame back out of the running renderer:
 * at the top of the dome the screen gives rgb(2, 4, 11) and `SKY_TOP`
 * linearises to rgb(2, 4, 11); at the hot band the screen gives
 * rgb(189, 64, 11) against `SKY_HOT`'s rgb(190, 65, 12), the unit of
 * difference being the shader's own smoothstep not landing exactly on the
 * stop at the pixel that was sampled. Mixed as hex instead, the same stops
 * would have painted a sky several times too bright.
 */
function skyAt(h: number): string {
  const top = linearRgb(SKY_TOP);
  const mid = linearRgb(SKY_MID);
  const hot = linearRgb(SKY_HOT);
  const horizon = linearRgb(SKY_HORIZON);
  let a: [number, number, number];
  let b: [number, number, number];
  let t: number;
  if (h > 0.25) {
    [a, b, t] = [mid, top, smoothstep(0.25, 0.6, h)];
  } else if (h > 0.05) {
    [a, b, t] = [hot, mid, smoothstep(0.05, 0.25, h)];
  } else {
    [a, b, t] = [horizon, hot, smoothstep(-0.05, 0.05, h)];
  }
  const mix = (i: number) => Math.round((a[i] + (b[i] - a[i]) * t) * 255);
  return `rgb(${mix(0)}, ${mix(1)}, ${mix(2)})`;
}

/** Where the skyline sits in the image: low enough that the range gathers in
    the bottom third and the score stands clear above the treeline. */
const HORIZON = 470;
/** How many flat bands the sky is painted in. Flat, per the spec — the wood
    is flat-shaded low-poly and a smooth gradient would not belong to it. */
const SKY_BANDS = 16;
/** The elevation the top edge of the image looks out at, as `sin`. Chosen so
    the deep blue above the orange is reached inside the frame, the way it is
    in play under the game's 72° field of view. */
const TOP_H = 0.62;

/**
 * The range, painted back to front.
 *
 * The order is the whole of it. The haze goes down over the trees but before
 * the fence, which is what gives the fence and the butts something to be
 * silhouetted against — the same job `scene.ts`'s fog does by starting at 35
 * units, in front of the far wood and behind everything nearer. The ground
 * goes down after the trees, so they stand in it rather than on it, and
 * before the fence and the butts, so those stand in front of it.
 */
function paintRange(c: CanvasRenderingContext2D): void {
  // Sky, as flat bands down to the horizon.
  const bandH = HORIZON / SKY_BANDS;
  for (let i = 0; i < SKY_BANDS; i++) {
    // The band's own middle, so the top and bottom bands are not clipped
    // stops but real samples of the gradient they belong to.
    const h = TOP_H * (1 - (i + 0.5) / SKY_BANDS);
    c.fillStyle = skyAt(h);
    c.fillRect(0, Math.floor(i * bandH), SHARE_W, Math.ceil(bandH) + 1);
  }

  // The sun: low, and on the right — `scene.ts` puts it over the shooter's
  // right shoulder at 13°, so it sits above the skyline on that side, and
  // clear of the column the words are set in.
  const sx = 1002;
  const sy = HORIZON - 104;
  const glow = c.createRadialGradient(sx, sy, 0, sx, sy, 270);
  glow.addColorStop(0, `rgba(${SUN}, 0.5)`);
  glow.addColorStop(0.35, `rgba(${SUN}, 0.13)`);
  glow.addColorStop(1, `rgba(${SUN}, 0)`);
  c.fillStyle = glow;
  c.fillRect(0, 0, SHARE_W, HORIZON);
  c.fillStyle = `rgba(${SUN}, 0.92)`;
  c.beginPath();
  c.arc(sx, sy, 27, 0, Math.PI * 2);
  c.fill();

  // The wood beyond the range: conifers, as one silhouette.
  c.fillStyle = TREE;
  c.beginPath();
  c.moveTo(0, HORIZON);
  let x = -40;
  // A repeatable jitter, so the treeline is irregular without the same round
  // drawing a different image twice.
  let seed = 7;
  const nextR = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  while (x < SHARE_W + 40) {
    const r = nextR();
    const w = 42 + r * 52;
    const tall = 52 + nextR() * 74;
    c.lineTo(x, HORIZON);
    c.lineTo(x + w / 2, HORIZON - tall);
    c.lineTo(x + w, HORIZON);
    x += w * 0.72;
  }
  c.lineTo(SHARE_W, HORIZON);
  c.closePath();
  c.fill();

  /*
   * The warm haze a low sun throws through a wood, in the scene's own fog
   * colour. Painted here rather than last: over the whole image it only
   * flattened everything, whereas between the trees and the fence it is the
   * thing the fence and the butts are read against. It stops at the horizon,
   * because below that is grass rather than distance, and lifting the grass
   * with it turned the foreground olive.
   */
  const haze = c.createLinearGradient(0, HORIZON - 130, 0, HORIZON);
  haze.addColorStop(0, `rgba(${HAZE}, 0)`);
  haze.addColorStop(1, `rgba(${HAZE}, 0.3)`);
  c.fillStyle = haze;
  c.fillRect(0, HORIZON - 130, SHARE_W, 130);

  // Ground, over the feet of the trees.
  c.fillStyle = GROUND;
  c.fillRect(0, HORIZON, SHARE_W, SHARE_H - HORIZON);

  // The palisade: a low run of sharpened stakes closing the range in, the
  // same shape `scene.ts`'s `palisade()` builds out of cylinders and cones,
  // and short enough here to stay a fence rather than a second treeline.
  const stakeW = 12;
  for (let px = -8; px < SHARE_W + 8; px += stakeW + 5) {
    const h = 26 + ((px * 37) % 9);
    const top = HORIZON + 4 - h;
    c.fillStyle = STAKE_DARK;
    c.fillRect(px, top, stakeW, h);
    // The sun is on the right, so it is the right-hand face that catches it.
    c.fillStyle = STAKE_LIT;
    c.fillRect(px + stakeW - 4, top, 4, h);
    c.beginPath();
    c.moveTo(px, top);
    c.lineTo(px + stakeW / 2, top - 10);
    c.lineTo(px + stakeW, top);
    c.closePath();
    c.fill();
  }

  /*
   * The butts, in two ranks: the far rank higher up the image and half the
   * size of the near one, which is the gap `RANKS` puts between them.
   *
   * Each is placed so its face meets the skyline rather than sitting wholly
   * on the grass: the far pair against the palisade and the hazed trees
   * above it, the near pair straddling the horizon line. A silhouette needs
   * something behind it, and below the horizon there is only near-black
   * ground.
   */
  const butt = (bx: number, baseY: number, r: number) => {
    const cy = baseY - r * 2;
    c.fillStyle = STAKE_DARK;
    c.fillRect(bx - r * 0.17, cy, r * 0.34, baseY - cy);
    c.beginPath();
    c.arc(bx, cy, r, 0, Math.PI * 2);
    c.fill();
    // A rim all the way round in the fog's own colour, then the brighter
    // catch on the side the sun is. Without the first of those the lower
    // half of a near butt is a dark disc on dark grass and reads as nothing
    // at all — a silhouette still has to have an edge to be one.
    c.lineWidth = 2;
    c.strokeStyle = `rgba(${HAZE}, 0.3)`;
    c.beginPath();
    c.arc(bx, cy, r - 1, 0, Math.PI * 2);
    c.stroke();
    c.strokeStyle = `rgba(${SUN}, 0.42)`;
    c.beginPath();
    c.arc(bx, cy, r - 1, -Math.PI * 0.42, Math.PI * 0.34);
    c.stroke();
  };
  butt(778, HORIZON + 58, 24);
  butt(1102, HORIZON + 70, 24);
  butt(872, HORIZON + 14, 12);
  butt(996, HORIZON + 10, 12);

  // The veil the words sit on: near-solid down the left where they are, and
  // almost clear on the right, so the sun and the butts still read rather
  // than the whole range being painted out to make room for type.
  const veil = c.createLinearGradient(0, 0, SHARE_W, 0);
  veil.addColorStop(0, `rgba(${VEIL}, 0.93)`);
  veil.addColorStop(0.6, `rgba(${VEIL}, 0.84)`);
  veil.addColorStop(1, `rgba(${VEIL}, 0.06)`);
  c.fillStyle = veil;
  c.fillRect(0, 0, SHARE_W, SHARE_H);
  // And along the bottom edge, under the mark.
  const foot = c.createLinearGradient(0, SHARE_H - 190, 0, SHARE_H);
  foot.addColorStop(0, `rgba(${VEIL}, 0)`);
  foot.addColorStop(1, `rgba(${VEIL}, 0.86)`);
  c.fillStyle = foot;
  c.fillRect(0, SHARE_H - 190, SHARE_W, 190);
}

/* ── the type ────────────────────────────────────────────────────────────── */

/** The two faces, resolved to whatever `next/font` actually called them. */
interface Faces {
  display: string;
  mono: string;
}

/* The type scale, in image pixels. */
const LAB_PX = 21;
const SCORE_PX = 172;
const LINE_PX = 23;
const PAD = 84;

/** What `site.css` falls back to, if the variables cannot be read at all. */
const FALLBACK: Faces = {
  display: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, "SF Mono", Menlo, monospace',
};

/**
 * The real family names, read off the page rather than guessed.
 *
 * `next/font` names the families itself, and not the same way twice: the dev
 * server serves `"Fraunces"` beside a generated `"Fraunces Fallback"`, while
 * a production build hashes it to something like `__Fraunces_1a2b3c`. So
 * there is no literal safe to hardcode, and a canvas that sets `ctx.font` to
 * a name that does not exist draws in a fallback serif without complaining.
 * The names are published as `--display` and `--mono-site` on `.site` (see
 * `site.css`), and the computed value of a custom property has its `var()`
 * references already substituted, so reading those two gives the whole
 * family list whichever build is serving it.
 *
 * Then `document.fonts.load` for each face actually used, and `fonts.ready`:
 * `display: "swap"` means the face can still be in flight when a round ends,
 * and the first `fillText` would draw the fallback without complaining.
 */
async function resolveFaces(): Promise<Faces> {
  const host = document.querySelector<HTMLElement>(".site") ?? document.documentElement;
  const css = getComputedStyle(host);
  const faces: Faces = {
    display: css.getPropertyValue("--display").trim() || FALLBACK.display,
    mono: css.getPropertyValue("--mono-site").trim() || FALLBACK.mono,
  };
  try {
    await Promise.all([
      document.fonts.load(`700 ${SCORE_PX}px ${faces.display}`),
      document.fonts.load(`600 ${LAB_PX}px ${faces.mono}`),
      document.fonts.load(`400 ${LINE_PX}px ${faces.mono}`),
    ]);
    await document.fonts.ready;
  } catch {
    // An old browser without the CSS Font Loading API still draws: the faces
    // are already in use elsewhere on this page by the time a round ends, so
    // the worst case is the same race `display: "swap"` has anyway.
  }
  return faces;
}

/** Letter-spacing, where the browser has it. `ctx.letterSpacing` is not
    universal; an engine without it simply ignores the assignment, which costs
    the tracking on two mono labels and nothing else. */
function track(c: CanvasRenderingContext2D, px: string): void {
  (c as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = px;
}

/**
 * The mark, if it loads.
 *
 * `/brand/wordmark@2x.webp` is same-origin (so it cannot taint the canvas)
 * and inside the production CSP's `img-src 'self'`. The 2x file is the one
 * worth having at this size; it is 253×48 and drawn at its own pixels.
 *
 * A failure here returns null and the image draws without it. That is the
 * spec's Failure principle — every piece degrades rather than blocking —
 * applied to a case its table does not list.
 */
function loadMark(): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = "/brand/wordmark@2x.webp";
  });
}

/**
 * Draw one finished round onto `canvas`, at 1200×675.
 *
 * Sizes the canvas itself, so the caller can hand over a bare
 * `document.createElement("canvas")`. Resolves the faces before the first
 * `ctx.font`, then paints the range, then the words over it.
 */
export async function drawShare(canvas: HTMLCanvasElement, run: Run): Promise<void> {
  canvas.width = SHARE_W;
  canvas.height = SHARE_H;
  const c = canvas.getContext("2d");
  if (!c) throw new Error("this browser gave no 2d canvas context");

  const faces = await resolveFaces();
  paintRange(c);

  c.textBaseline = "alphabetic";
  c.textAlign = "left";

  c.fillStyle = GOLD;
  c.font = `600 ${LAB_PX}px ${faces.mono}`;
  track(c, "3px");
  c.fillText("SHERWOOD SHOOTING RANGE", PAD, 112);
  track(c, "0px");

  // The score, and its unit beside it on the same baseline so a big number
  // alone is never left to mean whatever a stranger assumes it means.
  const score = run.points.toLocaleString("en-GB");
  c.fillStyle = INK;
  c.font = `700 ${SCORE_PX}px ${faces.display}`;
  const scoreY = 292;
  c.fillText(score, PAD, scoreY);
  const scoreW = c.measureText(score).width;
  c.fillStyle = BARK;
  c.font = `600 ${LAB_PX}px ${faces.mono}`;
  track(c, "3px");
  c.fillText("POINTS", PAD + scoreW + 22, scoreY);
  track(c, "0px");

  c.fillStyle = MOSS;
  c.font = `400 ${LINE_PX}px ${faces.mono}`;
  let y = 356;
  for (const line of shareLines(run)) {
    c.fillText(line, PAD, y);
    y += 39;
  }

  const mark = await loadMark();
  const footY = SHARE_H - PAD;
  if (mark) c.drawImage(mark, PAD, footY - mark.naturalHeight, mark.naturalWidth, mark.naturalHeight);

  c.fillStyle = BARK;
  c.font = `400 ${LAB_PX}px ${faces.mono}`;
  c.textAlign = "right";
  c.fillText("ponsnipe.com/range", SHARE_W - PAD, footY - 14);
  c.textAlign = "left";
}
