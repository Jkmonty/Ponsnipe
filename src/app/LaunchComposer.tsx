"use client";

import { useEffect, useState } from "react";
import { CollapseButton, useCollapsed } from "./Collapse";

/**
 * Compose a launch from a tweet.
 *
 * Drafts the fields, then checks them against our own 114,544-launch history —
 * which is the part no launchpad UI can give you. Whether a ticker has been
 * used four times today and died four times is real information about your
 * idea, and it is free for us to look up.
 *
 * It never deploys. Deploying stays a deliberate act on pons with your wallet.
 */

interface LaunchAdvice {
  field: string;
  level: "good" | "warn" | "bad";
  message: string;
}
interface TickerHistory {
  ticker: string;
  launches: number;
  graduated: number;
  recent24h: number;
  everGraduated: boolean;
  known: boolean;
}
interface DraftResult {
  draft: {
    name: string;
    symbol: string;
    description: string;
    imageUrl?: string;
    sourceUrl?: string;
    by: string;
    alternatives?: string[];
  };
  advice: LaunchAdvice[];
  history: TickerHistory;
  altHistory: TickerHistory[];
  baselineGraduationPct: number;
}

function verdict(h: TickerHistory | undefined): { cls: string; txt: string } | null {
  if (!h || !h.known) return null;
  if (h.launches === 0) return { cls: "pos", txt: "never used" };
  if (h.everGraduated) return { cls: "", txt: `${h.launches} used, ${h.graduated} graduated` };
  return { cls: "neg", txt: `${h.launches} used, none graduated` };
}

export default function LaunchComposer({ flash }: { flash: (k: "ok" | "err", m: string) => void }) {
  /* Was a local useState, so the composer reopened on every reload. It is the
     section most people want out of the way, which makes forgetting the worst
     thing it could do. */
  const fold = useCollapsed("composer", true);
  const [text, setText] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [tax, setTax] = useState(250);
  const [nativeQuote, setNativeQuote] = useState(false);
  const [res, setRes] = useState<DraftResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [meta, setMeta] = useState<{ drafter: string; claudeReady: boolean; insights: boolean } | null>(null);

  /* Only once the section is actually open, so a dashboard that loads with the
     composer folded does not fetch its capabilities for nobody. */
  const opened = !fold.collapsed;
  useEffect(() => {
    if (!opened) return;
    fetch("/api/launch")
      .then((r) => r.json())
      .then(setMeta)
      .catch(() => {
        /* transient */
      });
  }, [opened]);

  const run = async (override?: { symbol?: string; name?: string }) => {
    if (!text.trim()) {
      flash("err", "Paste a tweet or an idea first.");
      return;
    }
    setBusy(true);
    try {
      const r = await fetch("/api/launch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text,
          sourceUrl: sourceUrl || undefined,
          imageUrl: imageUrl || undefined,
          creatorTaxBps: tax,
          quoteIsNative: nativeQuote,
          ...override,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "draft failed");
      setRes(j as DraftResult);
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "draft failed");
    } finally {
      setBusy(false);
    }
  };

  const copy = (v: string, label: string) => {
    navigator.clipboard?.writeText(v).then(
      () => flash("ok", `${label} copied`),
      () => flash("err", "copy failed"),
    );
  };

  return (
    <div className={`card${fold.collapsed ? " is-collapsed" : ""}`}>
      <div className="card-head">
        <h2>Launch composer</h2>
        <CollapseButton
          collapsed={fold.collapsed}
          onToggle={fold.toggle}
          label="launch composer"
        />
      </div>
      <p className="muted small" style={{ marginTop: 4, marginBottom: 0 }}>
        Draft a launch from a tweet, checked against our own launch history.
      </p>
      {/*
        Said in its own colour and its own box, because it is the one thing
        about this section that will surprise someone: it writes the fields,
        it does not press the button. Deploying stays a deliberate act on pons
        with your own wallet, and the badge says that is today's answer rather
        than the permanent one.
      */}
      <p className="soon-note">
        <span className="soon-badge">Coming soon</span>
        Ponsnipe never deploys — you paste the fields into pons yourself. One-click launching
        is on the way.
      </p>

      {!fold.collapsed && (
        <div style={{ marginTop: 14 }}>
          <label className="small muted">Tweet text, or just the idea</label>
          <textarea
            className="input"
            rows={3}
            style={{ width: "100%", resize: "vertical", marginTop: 4 }}
            placeholder="Paste the tweet here…"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />

          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <input
              className="input"
              style={{ flex: 1, minWidth: 0 }}
              placeholder="Link to the tweet (optional)"
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
            />
            <input
              className="input"
              style={{ flex: 1, minWidth: 0 }}
              placeholder="Image URL (optional)"
              value={imageUrl}
              onChange={(e) => setImageUrl(e.target.value)}
            />
          </div>

          <div className="row" style={{ gap: 12, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>
            <label className="small muted">
              Creator tax
              <input
                className="input"
                type="number"
                style={{ width: 84, marginLeft: 6 }}
                value={tax}
                onChange={(e) => setTax(Number(e.target.value))}
              />
              <span style={{ marginLeft: 4 }}>bps</span>
            </label>
            <label className="small muted" style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={nativeQuote}
                onChange={(e) => setNativeQuote(e.target.checked)}
              />
              pair against ETH
            </label>
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => run()}>
              {busy ? "Drafting…" : "Draft it"}
            </button>
          </div>

          {meta && (
            <div className="small muted" style={{ marginTop: 8 }}>
              drafting by <strong>{meta.drafter === "claude" ? "Claude" : "built-in heuristic"}</strong>
              {!meta.claudeReady && " · add ANTHROPIC_API_KEY for better names"}
              {!meta.insights && " · no scan data, history checks unavailable"}
            </div>
          )}

          {res && (
            <div style={{ marginTop: 16 }}>
              <div className="feedrow want" style={{ padding: 12, gap: 6 }}>
                <div className="row" style={{ gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                  <span className="fsym" style={{ fontSize: 19, maxWidth: "none" }}>
                    {res.draft.symbol || "—"}
                  </span>
                  <span className="muted">{res.draft.name}</span>
                  {(() => {
                    const v = verdict(res.history);
                    return v ? <span className={`small ${v.cls}`}>· {v.txt}</span> : null;
                  })()}
                </div>
                <div className="small" style={{ marginTop: 4 }}>
                  {res.draft.description}
                </div>
                <div className="row" style={{ gap: 6, marginTop: 10, flexWrap: "wrap" }}>
                  <button className="btn btn-sm btn-outline" onClick={() => copy(res.draft.symbol, "Ticker")}>
                    Copy ticker
                  </button>
                  <button className="btn btn-sm btn-outline" onClick={() => copy(res.draft.name, "Name")}>
                    Copy name
                  </button>
                  <button
                    className="btn btn-sm btn-outline"
                    onClick={() => copy(res.draft.description, "Description")}
                  >
                    Copy description
                  </button>
                  <a
                    className="btn btn-sm btn-outline"
                    href="https://www.ponsfamily.com/launchpad/create"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open pons ↗
                  </a>
                </div>
              </div>

              {res.advice.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  {res.advice.map((a, i) => (
                    <div
                      key={i}
                      className={`small ${a.level === "bad" ? "neg" : a.level === "good" ? "pos" : ""}`}
                      style={{ color: a.level === "warn" ? "var(--amber)" : undefined, padding: "2px 0" }}
                    >
                      {a.level === "good" ? "✓" : a.level === "bad" ? "✗" : "!"} {a.message}
                    </div>
                  ))}
                </div>
              )}

              {(res.draft.alternatives ?? []).length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div className="small muted">Other tickers, with how each has done before:</div>
                  <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                    {(res.draft.alternatives ?? []).map((a, i) => {
                      const v = verdict(res.altHistory[i]);
                      return (
                        <button
                          key={a}
                          className="btn btn-sm btn-outline"
                          onClick={() => run({ symbol: a, name: res.draft.name })}
                        >
                          {a}
                          {v && (
                            <span className={`small ${v.cls}`} style={{ marginLeft: 6 }}>
                              · {v.txt}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
