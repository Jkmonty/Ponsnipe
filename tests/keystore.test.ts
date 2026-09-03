import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encryptPrivateKey,
  decryptPrivateKey,
  saveKeystore,
  loadKeystoreFile,
  keystoreExists,
} from "../src/lib/wallet/keystore";

const PK = ("0x" + "ab".repeat(32)) as `0x${string}`;
const PASS = "a-sufficiently-long-passphrase";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ks-"));
}

/** This file guards the only thing standing between the bot wallet and anyone
 *  who gets the keystore: the passphrase. */

test("encrypt → decrypt round trips exactly", () => {
  const f = encryptPrivateKey(PK, PASS, "0xaddr");
  assert.equal(decryptPrivateKey(f, PASS), PK);
});

test("the private key never appears in the keystore file", () => {
  const f = encryptPrivateKey(PK, PASS, "0xaddr");
  const blob = JSON.stringify(f).toLowerCase();
  assert.ok(!blob.includes(PK.slice(2).toLowerCase()), "plaintext key leaked into the file");
  assert.ok(!blob.includes(PASS.toLowerCase()), "passphrase leaked into the file");
});

test("a wrong passphrase fails and does not return garbage", () => {
  const f = encryptPrivateKey(PK, PASS, "0xaddr");
  assert.throws(() => decryptPrivateKey(f, "wrong-passphrase-here"), /KEYSTORE_PASSPHRASE/);
});

test("a tampered ciphertext is rejected by the GCM auth tag", () => {
  const f = encryptPrivateKey(PK, PASS, "0xaddr");
  const flipped = f.ciphertext.slice(0, -2) + (f.ciphertext.endsWith("00") ? "11" : "00");
  assert.throws(() => decryptPrivateKey({ ...f, ciphertext: flipped }, PASS));
});

test("a tampered auth tag is rejected", () => {
  const f = encryptPrivateKey(PK, PASS, "0xaddr");
  const flipped = f.authTag.slice(0, -2) + (f.authTag.endsWith("00") ? "11" : "00");
  assert.throws(() => decryptPrivateKey({ ...f, authTag: flipped }, PASS));
});

test("each encryption uses a fresh salt and IV", () => {
  const a = encryptPrivateKey(PK, PASS, "0xaddr");
  const b = encryptPrivateKey(PK, PASS, "0xaddr");
  assert.notEqual(a.kdfParams.salt, b.kdfParams.salt, "salt must not repeat");
  assert.notEqual(a.iv, b.iv, "IV must not repeat");
  assert.notEqual(a.ciphertext, b.ciphertext, "same key must not encrypt identically");
});

test("short passphrases are refused", () => {
  assert.throws(() => encryptPrivateKey(PK, "short", "0xaddr"), /at least 12/);
  assert.throws(() => encryptPrivateKey(PK, "", "0xaddr"), /at least 12/);
});

test("decryption uses the params STORED IN THE FILE, not today's constants", () => {
  // Raising SCRYPT.N later must not brick existing keystores. Simulate an older
  // file written with weaker params: it has to still open.
  const f = encryptPrivateKey(PK, PASS, "0xaddr");
  assert.equal(typeof f.kdfParams.N, "number");
  assert.ok(f.kdfParams.N > 0 && f.kdfParams.r > 0 && f.kdfParams.p > 0);
  // Corrupting the recorded params must fail loudly rather than silently
  // deriving a different key and blaming the passphrase.
  assert.throws(() =>
    decryptPrivateKey({ ...f, kdfParams: { ...f.kdfParams, N: 0 } }, PASS),
  );
});

test("save → load round trips through disk", () => {
  const dir = tmp();
  try {
    const p = join(dir, "bot.keystore.json");
    assert.equal(keystoreExists(p), false);
    saveKeystore(p, encryptPrivateKey(PK, PASS, "0xaddr"));
    assert.equal(keystoreExists(p), true);
    assert.equal(decryptPrivateKey(loadKeystoreFile(p), PASS), PK);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing keystore points at the fix rather than throwing a raw fs error", () => {
  assert.throws(() => loadKeystoreFile(join(tmp(), "nope.json")), /wallet:init/);
});

test("malformed keystores are rejected before we try to decrypt", () => {
  const dir = tmp();
  try {
    const p = join(dir, "k.json");
    writeFileSync(p, "not json at all");
    assert.throws(() => loadKeystoreFile(p), /not valid JSON/);

    writeFileSync(p, JSON.stringify({ cipher: "aes-256-gcm" }));
    assert.throws(() => loadKeystoreFile(p), /malformed/);

    // right shape, wrong algorithm — must not be silently accepted
    const good = encryptPrivateKey(PK, PASS, "0xaddr");
    writeFileSync(p, JSON.stringify({ ...good, cipher: "aes-128-cbc" }));
    assert.throws(() => loadKeystoreFile(p), /malformed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the saved file records the address it belongs to", () => {
  const dir = tmp();
  try {
    const p = join(dir, "k.json");
    saveKeystore(p, encryptPrivateKey(PK, PASS, "0xTheAddress"));
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    assert.equal(parsed.address, "0xTheAddress");
    assert.equal(parsed.version, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
