"use client";

import { useState } from "react";

/**
 * Create a fresh wallet, or bring your own.
 *
 * Importing is offered because "the app holds a key" is the part people balk
 * at, and some would rather reuse a burner they already control. It is not the
 * recommended path: this key signs unattended sells, so it should hold only
 * what is being traded either way.
 */
export default function WalletSetup({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (privateKey?: string) => void | Promise<void>;
}) {
  const [mode, setMode] = useState<"create" | "import">("create");
  const [key, setKey] = useState("");

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div className="row" style={{ gap: 6 }}>
        <button
          className={mode === "create" ? "btn btn-primary" : "btn"}
          onClick={() => setMode("create")}
          disabled={busy}
        >
          Create a new one
        </button>
        <button
          className={mode === "import" ? "btn btn-primary" : "btn"}
          onClick={() => setMode("import")}
          disabled={busy}
        >
          Use my own key
        </button>
      </div>

      {mode === "create" ? (
        <div>
          <button className="btn btn-primary" disabled={busy} onClick={() => onSubmit()}>
            {busy ? "Creating…" : "Create wallet"}
          </button>
          <p className="muted small" style={{ margin: "8px 0 0" }}>
            Recommended. A brand-new key that has never touched anything else, so nothing you
            already own is exposed if this machine is.
          </p>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          <input
            className="input mono"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="Private key (64 hex characters)"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          <div className="row" style={{ gap: 8 }}>
            <button
              className="btn btn-primary"
              disabled={busy || key.trim().replace(/^0x/i, "").length !== 64}
              onClick={async () => {
                await onSubmit(key.trim());
                setKey("");
              }}
            >
              {busy ? "Importing…" : "Import wallet"}
            </button>
            <span className="muted small">Encrypted with your passphrase, then discarded.</span>
          </div>
          <p className="neg small" style={{ margin: 0 }}>
            Import a burner, never your main wallet. Whatever you import can be spent by this
            app without asking, and by anyone who gets the keystore file and the passphrase.
          </p>
        </div>
      )}
    </div>
  );
}
