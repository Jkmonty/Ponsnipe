import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey } from "viem/accounts";
import type { Hex } from "viem";
import {
  addressOf,
  addressesOf,
  keyFrom,
  makeVault,
  normalisePrivateKey,
  openVault,
  resealVault,
  b64,
  unb64,
  type VaultV1,
} from "../src/app/vault";

/*
 * Node has WebCrypto and btoa/atob globally, but not in every shape this file
 * expects, so pin the two the vault uses. Nothing here touches the DOM.
 */
globalThis.btoa ??= (s: string) => Buffer.from(s, "binary").toString("base64");
globalThis.atob ??= (s: string) => Buffer.from(s, "base64").toString("binary");

const PASS = "correct horse battery staple";

test("a key put in comes back out", async () => {
  const pk = generatePrivateKey();
  const v = await makeVault([pk], PASS);
  assert.deepEqual(await openVault(v, PASS), [pk]);
  assert.deepEqual(v.addresses, [addressOf(pk)]);
});

test("several keys keep their order", async () => {
  const keys = [generatePrivateKey(), generatePrivateKey(), generatePrivateKey()];
  const v = await makeVault(keys, PASS);
  assert.deepEqual(await openVault(v, PASS), keys);
  assert.deepEqual(v.addresses, keys.map(addressOf));
});

test("the wrong passphrase fails rather than returning rubbish", async () => {
  const v = await makeVault([generatePrivateKey()], PASS);
  // AES-GCM authenticates, so a wrong key is a failure and not a bad decrypt.
  await assert.rejects(openVault(v, PASS + "!"));
});

test("a v1 vault still opens — nobody is locked out by this change", async () => {
  /*
   * v1 stored the key as a bare string rather than JSON. Built here the way
   * the old code built it, because the point of the test is that the format
   * written before this change is still readable after it.
   */
  const pk = generatePrivateKey();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ck = await keyFrom(PASS, salt);
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    ck,
    new TextEncoder().encode(pk),
  );
  const v1: VaultV1 = {
    v: 1,
    salt: b64(salt),
    iv: b64(iv),
    data: b64(data),
    address: addressOf(pk),
  };
  assert.deepEqual(await openVault(v1, PASS), [pk]);
  assert.deepEqual(addressesOf(v1), [addressOf(pk)]);
});

test("re-sealing keeps the passphrase and changes the IV", async () => {
  const a = generatePrivateKey();
  const b = generatePrivateKey();
  const v = await makeVault([a], PASS);
  const ck = await keyFrom(PASS, unb64(v.salt));
  const v2 = await resealVault(v, ck, [a, b]);
  /*
   * A fresh IV every time is not tidiness. AES-GCM reusing one under the same
   * key leaks the difference between the two plaintexts, and re-sealing
   * happens on every wallet added or removed.
   */
  assert.notEqual(v2.iv, v.iv);
  assert.equal(v2.salt, v.salt);
  assert.deepEqual(await openVault(v2, PASS), [a, b]);
  assert.deepEqual(v2.addresses, [addressOf(a), addressOf(b)]);
});

test("removing a wallet leaves the others openable", async () => {
  const keys = [generatePrivateKey(), generatePrivateKey(), generatePrivateKey()];
  const v = await makeVault(keys, PASS);
  const ck = await keyFrom(PASS, unb64(v.salt));
  const kept = [keys[0], keys[2]];
  assert.deepEqual(await openVault(await resealVault(v, ck, kept), PASS), kept);
});

test("addresses are readable while locked", async () => {
  const keys = [generatePrivateKey(), generatePrivateKey()];
  const v = await makeVault(keys, PASS);
  // No passphrase involved: the wallet list has to render before unlocking.
  assert.deepEqual(addressesOf(v), keys.map(addressOf));
});

test("a private key is accepted with or without the 0x, and junk is not", () => {
  const pk = generatePrivateKey();
  assert.equal(normalisePrivateKey(pk), pk);
  assert.equal(normalisePrivateKey(pk.slice(2)), pk);
  assert.equal(normalisePrivateKey(`  ${pk}  `), pk);
  for (const bad of ["", "0x", "not a key", pk.slice(0, 40), `${pk}ff`]) {
    assert.throws(() => normalisePrivateKey(bad as string), /not a private key/i, bad);
  }
});
