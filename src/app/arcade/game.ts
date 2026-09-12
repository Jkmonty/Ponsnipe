/**
 * The arcade, as a plain simulation.
 *
 * No React in here on purpose. A game loop that re-renders a component sixty
 * times a second is a component that is being asked to do something it is bad
 * at; this owns its own state, steps on a timer, and draws to a canvas. The
 * page around it only starts it, stops it, and reads the score.
 *
 * Targets are real tokenised shares with the day's real move attached. The
 * ones that are up are worth points. The ones that are down shoot back, which
 * is both the difficulty and the joke.
 */

export interface Stock {
  symbol: string;
  changePct: number;
}

export interface Snapshot {
  points: number;
  lives: number;
  hits: number;
  shots: number;
  combo: number;
  msLeft: number;
  over: boolean;
}

interface Target {
  stock: Stock;
  x: number;
  /** Which cover line it is behind. Its height comes from `out`. */
  lane: number;
  vx: number;
  r: number;
  /** 0 fully behind cover, 1 fully clear of it. */
  out: number;
  rising: boolean;
  /** Seconds until it ducks back, once fully out. */
  dwell: number;
  hostile: boolean;
  /** Seconds until it fires, for the hostile ones. */
  cooldown: number;
  dead: number;
}

/**
 * Where the cover sits, as a share of the height.
 *
 * Three walls. A target rises from behind one and only the part above the
 * wall can be hit — which is what makes a half-risen target a hard shot
 * rather than a slightly smaller one.
 */
const LANES = [0.46, 0.63, 0.8];

interface Bullet {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
}

/**
 * The forest, drawn once per size rather than per frame.
 *
 * A treeline generated inside the loop shimmers, because every frame gets
 * different random trunks. Generated once and cached, it stands still, which
 * is what a wood does.
 */
interface Scenery {
  w: number;
  h: number;
  far: { x: number; w: number; h: number }[];
  trunks: { x: number; lane: number; w: number }[];
}

const ROUND_MS = 60_000;
const START_LIVES = 3;
/** Below this the scope is wide; held, it magnifies and slows the sway. */
export const ZOOM = 2.4;

const rand = (a: number, b: number) => a + Math.random() * (b - a);

export class Arcade {
  private targets: Target[] = [];
  private bullets: Bullet[] = [];
  private last = 0;
  private spawnIn = 0.4;
  private raf = 0;
  private running = false;

  points = 0;
  lives = START_LIVES;
  hits = 0;
  shots = 0;
  combo = 0;
  msLeft = ROUND_MS;
  over = false;

  /** Where the scope is looking, in canvas pixels. */
  aim = { x: 0, y: 0 };
  zoomed = false;
  private scenery: Scenery | null = null;

  /** Build the wood for this canvas size, and keep it until the size changes. */
  private wood(): Scenery {
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (this.scenery && this.scenery.w === w && this.scenery.h === h) return this.scenery;
    const far: Scenery["far"] = [];
    for (let x = -20; x < w + 40; x += rand(26, 58)) {
      far.push({ x, w: rand(26, 54), h: rand(0.1, 0.22) * h });
    }
    const trunks: Scenery["trunks"] = [];
    for (let lane = 0; lane < LANES.length; lane++) {
      for (let x = rand(0, 120); x < w; x += rand(150, 280)) {
        trunks.push({ x, lane, w: rand(16, 30) });
      }
    }
    this.scenery = { w, h, far, trunks };
    return this.scenery;
  }

  constructor(
    private canvas: HTMLCanvasElement,
    private stocks: Stock[],
    private onChange: (s: Snapshot) => void,
  ) {}

  private snapshot(): Snapshot {
    return {
      points: this.points,
      lives: this.lives,
      hits: this.hits,
      shots: this.shots,
      combo: this.combo,
      msLeft: this.msLeft,
      over: this.over,
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.step(dt);
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private spawn() {
    if (!this.stocks.length) return;
    const s = this.stocks[Math.floor(Math.random() * this.stocks.length)];
    const w = this.canvas.width;
    const h = this.canvas.height;
    const fromLeft = Math.random() < 0.5;
    void h;
    this.targets.push({
      stock: s,
      x: fromLeft ? rand(0.08, 0.35) * w : rand(0.65, 0.92) * w,
      lane: Math.floor(Math.random() * LANES.length),
      vx: (fromLeft ? 1 : -1) * rand(34, 78),
      r: rand(19, 26),
      out: 0,
      rising: true,
      // Short. A target that stands still long enough to line up is a target
      // nobody misses, and the whole game was too easy because of it.
      dwell: rand(0.35, 0.95),
      // A share that is down today is hostile. Nothing arbitrary about which.
      hostile: s.changePct < 0,
      cooldown: rand(0.5, 1.1),
      dead: 0,
    });
  }

  /** Cover line for a lane, in canvas pixels. */
  private coverY(lane: number): number {
    return this.canvas.height * LANES[lane];
  }

  /**
   * Where a target's centre is right now.
   *
   * At out=0 it sits a full body below the wall and nothing shows. At out=1
   * the whole circle clears it. Everything between is a partial target, and
   * only the part above the wall can be hit.
   */
  private centreY(t: Target): number {
    return this.coverY(t.lane) + (t.r + 10) - t.out * (2 * t.r + 12);
  }

  private step(dt: number) {
    if (this.over) return;
    this.msLeft -= dt * 1000;
    if (this.msLeft <= 0 || this.lives <= 0) {
      this.msLeft = Math.max(0, this.msLeft);
      this.over = true;
      this.onChange(this.snapshot());
      return;
    }

    this.spawnIn -= dt;
    if (this.spawnIn <= 0) {
      this.spawn();
      // Quickens as the round runs down, so the last ten seconds are the hard
      // ones rather than the same as the first.
      const progress = 1 - this.msLeft / ROUND_MS;
      this.spawnIn = rand(0.5, 1.4) * (1 - progress * 0.55);
    }

    const w = this.canvas.width;
    for (const t of this.targets) {
      if (t.dead > 0) {
        t.dead -= dt;
        continue;
      }
      t.x += t.vx * dt;
      if (t.x < w * 0.06 || t.x > w * 0.94) t.vx *= -1;

      // Out of cover, wait, back down. A target fully out is the only one that
      // can be hit, and the only one that can shoot.
      if (t.rising) {
        t.out = Math.min(1, t.out + dt * 2.6);
        if (t.out >= 1) {
          t.dwell -= dt;
          if (t.dwell <= 0) t.rising = false;
        }
      } else {
        t.out = Math.max(0, t.out - dt * 2.6);
      }

      // Shoots the moment it is clear of cover, not once fully up.
      if (t.hostile && t.out > 0.55) {
        t.cooldown -= dt;
        if (t.cooldown <= 0) {
          t.cooldown = rand(0.9, 1.7);
          const ty = this.centreY(t);
          const dx = this.aim.x - t.x;
          const dy = this.aim.y - ty;
          const d = Math.hypot(dx, dy) || 1;
          /*
           * Accurate. It still has to travel, so moving the scope beats it —
           * which is the skill being asked for. Standing still does not.
           */
          const speed = 330;
          const spread = 7;
          this.bullets.push({
            x: t.x,
            y: ty,
            vx: (dx / d) * speed + rand(-spread, spread),
            vy: (dy / d) * speed + rand(-spread, spread),
            life: 3,
          });
        }
      }
    }
    this.targets = this.targets.filter((t) => t.dead <= 0 || t.dead > -1);
    this.targets = this.targets.filter((t) => !(t.dead < 0));
    if (this.targets.length > 14) this.targets.splice(0, this.targets.length - 14);

    for (const b of this.bullets) {
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.life -= dt;
      // A hit is on the scope's centre — where you are looking is where you are.
      if (Math.hypot(b.x - this.aim.x, b.y - this.aim.y) < 14) {
        b.life = 0;
        this.lives -= 1;
        this.combo = 0;
        // Getting hit costs the board, not just the round. Lives alone made
        // being shot a free mistake until the third one.
        this.points = Math.max(0, this.points - 250);
        this.onChange(this.snapshot());
      }
    }
    this.bullets = this.bullets.filter((b) => b.life > 0);
  }

  /** Fire at the current aim. Returns whether anything was hit. */
  fire(): boolean {
    if (this.over) return false;
    this.shots += 1;
    let best: Target | null = null;
    let bestD = Infinity;
    for (const t of this.targets) {
      if (t.dead > 0 || t.out <= 0.12) continue;
      const cy = this.centreY(t);
      // Above the wall, or it is not there to be shot. A half-risen target is
      // a smaller target rather than an easier one.
      if (this.aim.y > this.coverY(t.lane)) continue;
      const d = Math.hypot(t.x - this.aim.x, cy - this.aim.y);
      if (d < t.r && d < bestD) {
        best = t;
        bestD = d;
      }
    }
    if (!best) {
      this.combo = 0;
      this.onChange(this.snapshot());
      return false;
    }

    best.dead = 0.35;
    this.hits += 1;
    this.combo += 1;
    /*
     * Worth what it moved. A share up four percent is worth four times one up
     * one percent, so the board rewards knowing which ones are running — and
     * a hostile one is worth more because it was shooting at you.
     */
    const move = Math.abs(best.stock.changePct);
    const base = Math.round(40 + move * 60);
    this.points += Math.round((best.hostile ? base * 1.6 : base) * (1 + this.combo * 0.08));
    this.onChange(this.snapshot());
    return true;
  }

  private draw() {
    const c = this.canvas.getContext("2d");
    if (!c) return;
    const w = this.canvas.width;
    const h = this.canvas.height;

    /*
     * Sherwood at dusk.
     *
     * The palette stays the app's — near-black ground, lime for what is safe,
     * red for what is not — so the range looks like part of Ponsnipe rather
     * than a game someone bolted on. The forest is the setting, not a repaint.
     */
    const sky = c.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, "#0a1410");
    sky.addColorStop(0.45, "#0b1a14");
    sky.addColorStop(1, "#06070a");
    c.fillStyle = sky;
    c.fillRect(0, 0, w, h);

    const scene = this.wood();

    // A far treeline, flat and dark, for depth behind everything else.
    c.fillStyle = "#081310";
    for (const t of scene.far) {
      c.beginPath();
      c.moveTo(t.x, h * 0.42);
      c.lineTo(t.x + t.w / 2, h * 0.42 - t.h);
      c.lineTo(t.x + t.w, h * 0.42);
      c.closePath();
      c.fill();
    }

    /*
     * Targets, then the hedgerow they rise from.
     *
     * Drawn in that order so the part still below the line is painted and
     * then buried — which is what makes a half-risen butt read as something
     * rising from cover rather than a circle that got smaller.
     */
    for (const t of this.targets) {
      if (t.out <= 0.02) continue;
      const y = this.centreY(t);
      const hit = t.dead > 0;
      const alpha = hit ? Math.max(0, t.dead / 0.35) : 1;
      c.globalAlpha = alpha;

      // An archery butt: straw roundel, painted rings, ticker across it.
      c.beginPath();
      c.arc(t.x, y, t.r, 0, Math.PI * 2);
      c.fillStyle = hit ? "#eef1f5" : "#c9b083";
      c.fill();
      for (const [frac, col] of [[0.72, t.hostile ? "#ff5d5d" : "#7ae089"], [0.42, "#f5efe0"], [0.16, t.hostile ? "#ff5d5d" : "#7ae089"]] as const) {
        c.beginPath();
        c.arc(t.x, y, t.r * frac, 0, Math.PI * 2);
        c.fillStyle = col;
        c.fill();
      }
      c.lineWidth = 2;
      c.strokeStyle = t.hostile ? "#ff5d5d" : "#7ae089";
      c.beginPath();
      c.arc(t.x, y, t.r, 0, Math.PI * 2);
      c.stroke();

      c.fillStyle = "#0b0f14";
      c.font = "700 11px ui-monospace, monospace";
      c.textAlign = "center";
      c.fillText(t.stock.symbol, t.x, y + 4);
      c.globalAlpha = 1;
    }

    // Trunks rising through the hedgerows.
    for (const tr of scene.trunks) {
      const base = h * LANES[tr.lane] + h * 0.085;
      c.fillStyle = "#0e1712";
      c.fillRect(tr.x, base - h * 0.34, tr.w, h * 0.34);
      c.fillStyle = "#122019";
      c.fillRect(tr.x, base - h * 0.34, Math.max(3, tr.w * 0.3), h * 0.34);
    }

    // The hedgerow itself: scalloped, so it reads as undergrowth rather than a
    // wall with a straight top.
    for (let i = 0; i < LANES.length; i++) {
      const y = h * LANES[i];
      const band = h * 0.085;
      c.fillStyle = i === 0 ? "#0d1a14" : i === 1 ? "#0f1f17" : "#11241b";
      c.beginPath();
      c.moveTo(0, y + 8);
      for (let x = 0; x <= w; x += 26) {
        c.quadraticCurveTo(x + 13, y - 6, x + 26, y + 8);
      }
      c.lineTo(w, y + band);
      c.lineTo(0, y + band);
      c.closePath();
      c.fill();
    }

    // Arrows, drawn along their heading. A dot gives no sense of where a
    // thing is going, which is the only information that lets you dodge it.
    for (const b of this.bullets) {
      const a = Math.atan2(b.vy, b.vx);
      const len = 16;
      c.save();
      c.translate(b.x, b.y);
      c.rotate(a);
      c.strokeStyle = "#e8d9a8";
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(-len, 0);
      c.lineTo(4, 0);
      c.stroke();
      c.fillStyle = "#ff5d5d";
      c.beginPath();
      c.moveTo(8, 0);
      c.lineTo(0, -3.5);
      c.lineTo(0, 3.5);
      c.closePath();
      c.fill();
      // Fletching.
      c.strokeStyle = "#7ae089";
      c.beginPath();
      c.moveTo(-len, -3);
      c.lineTo(-len + 5, 0);
      c.moveTo(-len, 3);
      c.lineTo(-len + 5, 0);
      c.stroke();
      c.restore();
    }

    // The scope. Everything outside the glass is dark, which is what makes it
    // a scope rather than a cursor.
    const rad = this.zoomed ? Math.min(w, h) * 0.22 : Math.min(w, h) * 0.34;
    c.save();
    c.beginPath();
    c.rect(0, 0, w, h);
    c.arc(this.aim.x, this.aim.y, rad, 0, Math.PI * 2, true);
    c.fillStyle = "rgba(2,3,5,0.9)";
    c.fill("evenodd");
    c.restore();

    c.beginPath();
    c.arc(this.aim.x, this.aim.y, rad, 0, Math.PI * 2);
    c.strokeStyle = "rgba(238,241,245,0.35)";
    c.lineWidth = 2;
    c.stroke();

    c.strokeStyle = "rgba(238,241,245,0.55)";
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(this.aim.x - rad, this.aim.y);
    c.lineTo(this.aim.x - 8, this.aim.y);
    c.moveTo(this.aim.x + 8, this.aim.y);
    c.lineTo(this.aim.x + rad, this.aim.y);
    c.moveTo(this.aim.x, this.aim.y - rad);
    c.lineTo(this.aim.x, this.aim.y - 8);
    c.moveTo(this.aim.x, this.aim.y + 8);
    c.lineTo(this.aim.x, this.aim.y + rad);
    c.stroke();
    c.beginPath();
    c.arc(this.aim.x, this.aim.y, 2, 0, Math.PI * 2);
    c.fillStyle = "#c3f53c";
    c.fill();
  }
}

export { ROUND_MS, START_LIVES };
