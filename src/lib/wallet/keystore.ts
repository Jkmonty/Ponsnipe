import {
  randomBytes,
  scryptSync,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { Hex } from "viem";

/**
 * Encrypted keystore for the bot wallet private key.
 * AES-256-GCM, key derived from the passphrase with scrypt. Format is our own
 * (not web3 keystore v3) — deliberately simple and auditable.
 */

interface KeystoreFile {
  version: 1;
  cipher: "aes-256-gcm";
  kdf: "scrypt";
  kdfParams: { N: number; r: number; p: number; keylen: number; salt: string };
  iv: string;
  authTag: string;
  ciphertext: string;
  address: string;
  createdAt: string;
}

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 32 } as const;

interface KdfParams {
  N: number;
  r: number;
  p: number;
  keylen: number;
}

function deriveKeyWith(passphrase: string, salt: Buffer, params: KdfParams): Buffer {
  const { N, r, p, keylen } = params;
  if (![N, r, p, keylen].every((v) => Number.isInteger(v) && v > 0)) {
    throw new Error("Keystore has invalid or missing kdfParams — file is corrupt");
  }
  return scryptSync(passphrase, salt, keylen, {
    N,
    r,
    p,
    maxmem: 512 * 1024 * 1024,
  });
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return deriveKeyWith(passphrase, salt, SCRYPT);
}

export function encryptPrivateKey(
  privateKey: Hex,
  passphrase: string,
  address: string,
): KeystoreFile {
  if (!passphrase || passphrase.length < 12) {
    throw new Error("KEYSTORE_PASSPHRASE must be at least 12 characters");
  }
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const pkBytes = Buffer.from(privateKey.replace(/^0x/, ""), "hex");
  const ciphertext = Buffer.concat([cipher.update(pkBytes), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    version: 1,
    cipher: "aes-256-gcm",
    kdf: "scrypt",
    kdfParams: { ...SCRYPT, salt: salt.toString("hex") },
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
    ciphertext: ciphertext.toString("hex"),
    address,
    createdAt: new Date().toISOString(),
  };
}

export function decryptPrivateKey(file: KeystoreFile, passphrase: string): Hex {
  // Derive with the params the FILE was written with, not today's constants —
  // otherwise raising SCRYPT.N later would make every existing keystore
  // undecryptable behind a misleading "wrong passphrase" error.
  const salt = Buffer.from(file.kdfParams.salt, "hex");
  const key = deriveKeyWith(passphrase, salt, file.kdfParams);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(file.iv, "hex"));
  decipher.setAuthTag(Buffer.from(file.authTag, "hex"));
  try {
    const pt = Buffer.concat([
      decipher.update(Buffer.from(file.ciphertext, "hex")),
      decipher.final(),
    ]);
    return `0x${pt.toString("hex")}` as Hex;
  } catch {
    throw new Error("Failed to decrypt keystore — wrong KEYSTORE_PASSPHRASE?");
  }
}

export function saveKeystore(path: string, file: KeystoreFile): void {
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(file, null, 2), { mode: 0o600 });
}

export function loadKeystoreFile(path: string): KeystoreFile {
  if (!existsSync(path)) {
    throw new Error(
      `No keystore at ${path}. Create the bot wallet first: npm run wallet:init`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`Keystore at ${path} is not valid JSON — restore your backup`);
  }
  const f = parsed as Partial<KeystoreFile>;
  const ok =
    f &&
    f.cipher === "aes-256-gcm" &&
    f.kdf === "scrypt" &&
    typeof f.iv === "string" &&
    typeof f.authTag === "string" &&
    typeof f.ciphertext === "string" &&
    !!f.kdfParams &&
    typeof f.kdfParams.salt === "string";
  if (!ok) {
    throw new Error(`Keystore at ${path} is malformed — restore your backup`);
  }
  return parsed as KeystoreFile;
}

export function keystoreExists(path: string): boolean {
  return existsSync(path);
}
