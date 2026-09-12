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
  /** Lane the target walks along, 0..1 across the field. */
  x: number;
  y: number;
  vx: number;
  r: number;
  /** 0 hidden, 1 fully out of cover. Targets duck rather than vanish. */
  out: number;
  rising: boolean;
  /** Seconds until it ducks back, once fully out. */
  dwell: number;
  hostile: boolean;
  /** Seconds until it fires, for the hostile ones. */
  cooldown: number;
  dead: number;
}

interface Bullet {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
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
    this.targets.push({
      stock: s,
      x: fromLeft ? rand(0.08, 0.35) * w : rand(0.65, 0.92) * w,
      // Three rows of cover, so the eye has somewhere to expect them.
      y: h * [0.42, 0.58, 0.74][Math.floor(Math.random() * 3)],
      vx: (fromLeft ? 1 : -1) * rand(18, 46),
      r: rand(26, 34),
      out: 0,
      rising: true,
      dwell: rand(0.7, 1.8),
      // A share that is down today is hostile. Nothing arbitrary about which.
      hostile: s.changePct < 0,
      cooldown: rand(0.8, 1.6),
      dead: 0,
    });
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

      if (t.hostile && t.out >= 1) {
        t.cooldown -= dt;
        if (t.cooldown <= 0) {
          t.cooldown = rand(1.4, 2.6);
          const dx = this.aim.x - t.x;
          const dy = this.aim.y - t.y;
          const d = Math.hypot(dx, dy) || 1;
          // Aimed where the scope is, not at it — a shot you cannot dodge is
          // not difficulty, it is a tax.
          const speed = 210;
          this.bullets.push({
            x: t.x,
            y: t.y,
            vx: (dx / d) * speed + rand(-40, 40),
            vy: (dy / d) * speed + rand(-40, 40),
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
      if (Math.hypot(b.x - this.aim.x, b.y - this.aim.y) < 16) {
        b.life = 0;
        this.lives -= 1;
        this.combo = 0;
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
      if (t.dead > 0 || t.out < 0.8) continue;
      const d = Math.hypot(t.x - this.aim.x, t.y - this.aim.y);
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

    c.fillStyle = "#06070a";
    c.fillRect(0, 0, w, h);

    // Cover: three bands the targets rise from.
    c.fillStyle = "#0c0e13";
    for (const y of [0.42, 0.58, 0.74]) {
      c.fillRect(0, h * y + 16, w, h * 0.11);
    }

    for (const t of this.targets) {
      if (t.out <= 0.02) continue;
      const y = t.y + (1 - t.out) * 44;
      const hit = t.dead > 0;
      c.globalAlpha = hit ? Math.max(0, t.dead / 0.35) : 1;
      c.beginPath();
      c.arc(t.x, y, t.r, 0, Math.PI * 2);
      c.fillStyle = hit ? "#eef1f5" : t.hostile ? "rgba(255,93,93,0.18)" : "rgba(122,224,137,0.18)";
      c.fill();
      c.lineWidth = 2;
      c.strokeStyle = t.hostile ? "#ff5d5d" : "#7ae089";
      c.stroke();

      c.fillStyle = t.hostile ? "#ff5d5d" : "#7ae089";
      c.font = "600 13px ui-monospace, monospace";
      c.textAlign = "center";
      c.fillText(t.stock.symbol, t.x, y + 4);
      c.font = "11px ui-monospace, monospace";
      c.globalAlpha = (hit ? t.dead / 0.35 : 1) * 0.75;
      c.fillText(`${t.stock.changePct >= 0 ? "+" : ""}${t.stock.changePct.toFixed(1)}%`, t.x, y + t.r + 14);
      c.globalAlpha = 1;
    }

    for (const b of this.bullets) {
      c.beginPath();
      c.arc(b.x, b.y, 3.5, 0, Math.PI * 2);
      c.fillStyle = "#ff5d5d";
      c.fill();
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
