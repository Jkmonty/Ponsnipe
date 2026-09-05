import { LAUNCH_DEFAULTS } from "./insights";

/**
 * Turning a piece of source material — usually a tweet — into launch fields.
 *
 * Two implementations behind one interface. The heuristic one runs with no
 * setup and no cost; the Anthropic one is better at the actual creative bit
 * (reading a joke and naming it) and needs an API key, which is separate from
 * a Claude subscription. Nothing else in the composer knows which is in use, so
 * the key can arrive later without touching the UI or the route.
 */

export interface SourceMaterial {
  /** Raw text — a tweet, a headline, or just an idea typed in. */
  text: string;
  /** Optional link kept alongside the token so the origin is traceable. */
  sourceUrl?: string;
  /** Optional image URL lifted from the source. */
  imageUrl?: string;
}

export interface LaunchDraft {
  name: string;
  symbol: string;
  description: string;
  imageUrl?: string;
  sourceUrl?: string;
  /** Which drafter produced this, so the UI can say so plainly. */
  by: "heuristic" | "claude";
  /** Alternative tickers worth considering. */
  alternatives?: string[];
}

export interface Drafter {
  readonly kind: "heuristic" | "claude";
  available(): boolean;
  draft(input: SourceMaterial): Promise<LaunchDraft>;
}

/** Words that carry no meaning in a ticker. */
const STOP = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for", "with", "is", "are", "was",
  "were", "be", "been", "this", "that", "it", "its", "at", "by", "from", "as", "has", "have", "had",
  "will", "just", "you", "your", "we", "our", "they", "their", "not", "no", "so", "if", "when",
  "what", "who", "how", "all", "can", "get", "got", "now", "new", "one", "out", "up", "about",
  "https", "http", "com", "www", "rt", "via",
]);

function words(text: string): string[] {
  return text
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 1 && !STOP.has(w.toLowerCase()));
}

/**
 * No-setup drafter. Picks the most distinctive words and shapes them into the
 * form the data says does best: short, ALL CAPS, letters only.
 *
 * It is deliberately unclever. Naming a meme is the one part of this a model is
 * genuinely better at, so this exists to keep the tool usable without a key,
 * not to compete with the model.
 */
export const heuristicDrafter: Drafter = {
  kind: "heuristic",
  available: () => true,
  async draft(input: SourceMaterial): Promise<LaunchDraft> {
    const ws = words(input.text);
    // Prefer capitalised words: in a tweet those are usually the subject.
    const proper = ws.filter((w) => /^[A-Z]/.test(w) && w.length >= 3);
    const pool = (proper.length ? proper : ws).slice(0, 12);

    const pick = pool[0] ?? "MEME";
    const symbol = pick
      .toUpperCase()
      .replace(/[^A-Z]/g, "")
      .slice(0, LAUNCH_DEFAULTS.maxSymbolChars) || "MEME";

    const name = (pool.slice(0, 3).join(" ") || "Meme Token").slice(0, LAUNCH_DEFAULTS.maxNameChars);
    const description = input.text.trim().replace(/\s+/g, " ").slice(0, 200);

    const alternatives = [...new Set(pool.slice(1, 6).map((w) => w.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 5)))]
      .filter((a) => a.length >= 2 && a !== symbol)
      .slice(0, 4);

    return {
      name,
      symbol,
      description,
      imageUrl: input.imageUrl,
      sourceUrl: input.sourceUrl,
      by: "heuristic",
      alternatives,
    };
  },
};

/**
 * The model does the creative half. Kept to Haiku: this is a short, easy
 * generation where latency matters more than depth, and it costs a fraction of
 * a penny per launch.
 */
const MODEL = process.env.ANTHROPIC_MODEL?.trim() || "claude-haiku-4-5-20251001";

const SYSTEM = `You name memecoins for a launchpad. Given source material (usually a tweet), produce ONE launch.

Hard rules, measured across 114,544 real launches:
- symbol: 3-5 characters, A-Z only, no digits. 4-5 chars graduate at 1.79% vs 0.87% at 9-12; digits drop it to 1.05%.
- name: under 32 characters.
- description: one or two sentences, under 200 characters. Say what the joke is.
- The ticker should be the thing a person would actually shout. Obvious beats clever.

Return ONLY JSON: {"name":"","symbol":"","description":"","alternatives":["",""]}`;

export const claudeDrafter: Drafter = {
  kind: "claude",
  available: () => Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
  async draft(input: SourceMaterial): Promise<LaunchDraft> {
    const key = process.env.ANTHROPIC_API_KEY?.trim();
    if (!key) throw new Error("ANTHROPIC_API_KEY is not set");

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 400,
        system: SYSTEM,
        messages: [{ role: "user", content: input.text.slice(0, 4000) }],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = json.content?.find((c) => c.type === "text")?.text ?? "";
    // The model is told to return bare JSON, but a stray fence is cheap to survive.
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("model did not return JSON");
    const parsed = JSON.parse(m[0]) as Partial<LaunchDraft>;

    return {
      name: String(parsed.name ?? "").slice(0, LAUNCH_DEFAULTS.maxNameChars),
      symbol: String(parsed.symbol ?? "")
        .toUpperCase()
        .replace(/[^A-Z]/g, "")
        .slice(0, 10),
      description: String(parsed.description ?? "").slice(0, 200),
      imageUrl: input.imageUrl,
      sourceUrl: input.sourceUrl,
      by: "claude",
      alternatives: Array.isArray(parsed.alternatives)
        ? parsed.alternatives.map((a) => String(a).toUpperCase().replace(/[^A-Z]/g, "").slice(0, 10)).slice(0, 5)
        : [],
    };
  },
};

/** Whichever drafter is usable right now, model first. */
export function activeDrafter(): Drafter {
  return claudeDrafter.available() ? claudeDrafter : heuristicDrafter;
}
