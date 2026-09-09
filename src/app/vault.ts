/**
 * The encrypted store the browser trading keys live in.
 *
 * Pulled out of useTradingKey so it can be tested. It was inline in a React
 * hook, which meant the one piece of code in this project that protects money
 * had no tests at all — every other sensitive path here does. Nothing in this
 * file touches React, the DOM or localStorage; it turns keys into a vault and
 * back, and the hook decides where to put it.
 *
 * Keys are held as an array from v2 onward. A single wallet is the array with
 * one entry in it, so there is one code path rather than two.
 */
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";

/** The original shape: exactly one key, and its address in the clear. */
export interface VaultV1 {
  v: 1;
  salt: string;
  iv: string;
  data: string;
  address: Address;
}

/**
 * Many keys, and their addresses in the clear.
 *
 * Addresses are not secret — they are on a public chain — and keeping them
 * outside the ciphertext is what lets the UI list the wallets while locked.
 * Only the private keys are encrypted.
 */
export interface VaultV2 {
  v: 2;
  salt: string;
  iv: string;
  data: string;
  addresses: Address[];
}

export type Vault = VaultV1 | VaultV2;

export const b64 = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b as ArrayBuffer)));
export const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * PBKDF2 at 310,000 rounds, which is OWASP's figure for SHA-256.
 *
 * The cost is deliberate: it is what stands between a stolen localStorage
 * blob and the key inside it, and a passphrase is the only secret involved.
 */
export async function keyFrom(pass: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pass),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: 310_000, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Seal a set of keys under an already-derived key.
 *
 * A fresh initialisation vector every time, which is not optional: AES-GCM
 * reusing an IV under the same key leaks the plaintext difference between the
 * two messages. Re-sealing happens on every wallet added or removed, so this
 * would be reused often if it were not regenerated here.
 */
export async function sealKeys(cryptoKey: CryptoKey, keys: Hex[]): Promise<{ iv: string; data: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    cryptoKey,
    new TextEncoder().encode(JSON.stringify(keys)),
  );
  return { iv: b64(iv), data: b64(data) };
}

/**
 * Open a vault of either version.
 *
 * v1 held a bare key string rather than JSON, so it is recognised by failing
 * to parse — a private key is not valid JSON. Reading it as one key keeps
 * every wallet made before this change openable with the same passphrase.
 */
export async function openVault(v: Vault, pass: string): Promise<Hex[]> {
  const cryptoKey = await keyFrom(pass, unb64(v.salt));
  const out = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64(v.iv) as BufferSource },
    cryptoKey,
    unb64(v.data) as BufferSource,
  );
  const text = new TextDecoder().decode(out);
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed) && parsed.every((k) => typeof k === "string")) return parsed as Hex[];
  } catch {
    /* v1: the plaintext is the key itself */
  }
  return [text as Hex];
}

/** Build a vault from scratch, deriving a key from the passphrase. */
export async function makeVault(keys: Hex[], pass: string): Promise<VaultV2> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cryptoKey = await keyFrom(pass, salt);
  const { iv, data } = await sealKeys(cryptoKey, keys);
  return { v: 2, salt: b64(salt), iv, data, addresses: keys.map(addressOf) };
}

/** Re-seal an open vault with a changed set of keys, salt unchanged. */
export async function resealVault(v: Vault, cryptoKey: CryptoKey, keys: Hex[]): Promise<VaultV2> {
  const { iv, data } = await sealKeys(cryptoKey, keys);
  return { v: 2, salt: v.salt, iv, data, addresses: keys.map(addressOf) };
}

export function addressOf(pk: Hex): Address {
  return privateKeyToAccount(pk).address;
}

/** Every address in a vault, whichever version it is, without the passphrase. */
export function addressesOf(v: Vault | null): Address[] {
  if (!v) return [];
  return v.v === 1 ? [v.address] : v.addresses;
}

/** Is this a private key, written with or without the 0x? */
export function normalisePrivateKey(input: string): Hex {
  const t = input.trim();
  const pk = t.startsWith("0x") ? t : `0x${t}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error("That is not a private key.");
  return pk as Hex;
}
