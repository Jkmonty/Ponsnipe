"use client";

/**
 * Sections you can fold away, and that stay folded.
 *
 * The dashboard is a column of cards that are each useful occasionally and
 * present always — the launch composer, the token lookup, the sniper filters.
 * Once you have set the sniper up you do not want to scroll past it forever to
 * reach the positions underneath.
 *
 * Collapsed state is per section and kept in localStorage, because a fold that
 * resets on reload is worse than no fold at all: you do the tidying again every
 * time you open the app, which teaches you not to bother.
 */
import { useCallback, useEffect, useState } from "react";

const STORE = "ponsnipe.collapsed.v1";

function readAll(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
}

/**
 * Remembered open/closed state for one section.
 *
 * `id` is the storage key, so it must stay stable across renames of the
 * heading — a section renamed from "Buy" to "Buy a token" should not silently
 * reopen for everyone who had folded it.
 */
export function useCollapsed(id: string, defaultCollapsed = false) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  // After mount: localStorage does not exist while rendering on the server,
  // and reading it during render would make the first client paint disagree
  // with the HTML it replaces.
  useEffect(() => {
    const all = readAll();
    if (id in all) setCollapsed(all[id]);
  }, [id]);

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(STORE, JSON.stringify({ ...readAll(), [id]: next }));
      } catch {
        /* private mode: the fold holds for this session and no longer */
      }
      return next;
    });
  }, [id]);

  return { collapsed, toggle };
}

/**
 * The fold control itself.
 *
 * A chevron rather than a word, because it sits in a header row that often
 * already carries a chip and a switch, and a third piece of text there turns
 * the heading into a sentence. It keeps a real label for screen readers and a
 * title for everyone else.
 */
export function CollapseButton({
  collapsed,
  onToggle,
  label,
}: {
  collapsed: boolean;
  onToggle: () => void;
  /** What is being folded, for the accessible name: "Sniper". */
  label: string;
}) {
  return (
    <button
      type="button"
      className="collapse-btn"
      onClick={onToggle}
      aria-expanded={!collapsed}
      aria-label={`${collapsed ? "Show" : "Hide"} ${label}`}
      title={collapsed ? `Show ${label}` : `Hide ${label}`}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M6 9l6 6 6-6"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
