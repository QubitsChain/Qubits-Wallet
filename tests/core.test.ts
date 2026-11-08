// @vitest-environment node
// The real WebAssembly core, as the popup uses it.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import type { AccountResponse, StatusResponse } from "../src/shared/api";
import status from "./fixtures/status.json";
import type { CreatedKey } from "../src/core";
import { PASSWORD, testCore } from "./setup";

const core = testCore();
let key: CreatedKey;

function freshAccount(address: string): AccountResponse {
  return {
    address,
    exists: true,
    nonce: 0,
    auth: null,
    vault: null,
    balances: [{ asset: 0, amount: "1000000" }],
    pending: [],
  };
}

beforeAll(() => {
  key = core.createKey("ml-dsa-65", PASSWORD);
});

describe("keys", () => {
  it("creates a key file whose public facts can be read without the password", () => {
    expect(key.address).toMatch(/^qb1/);
    expect(key.scheme).toBe("ml-dsa-65");
    expect(key.public_key.slice(0, 2)).toBe("01");
    const { keystore, ...info } = key;
    expect(core.keyInfo(keystore)).toEqual(info);
    expect(core.publicKeyInfo(key.public_key)).toEqual(info);
  });

  it("checks passwords", () => {
    expect(() => core.checkPassword(key.keystore, PASSWORD)).not.toThrow();
    expect(() => core.checkPassword(key.keystore, "not the password at all")).toThrow("wrong password");
    expect(() => core.createKey("ml-dsa-65", "short")).toThrow("at least 12");
    expect(core.minPasswordLength).toBe(12);
  });

  it("validates addresses", () => {
    expect(core.checkAddress(` ${key.address.toUpperCase()} `)).toBe(key.address);
    expect(() => core.checkAddress("qb1notanaddress")).toThrow();
  });

  const chain =
    process.env.QUBITS_CHAIN ??
    fileURLToPath(new URL(existsSync(new URL("../chain/Cargo.toml", import.meta.url)) ? "../chain" : "../../chain", import.meta.url));
  const cli = join(chain, "target/debug/qubits");
  it.skipIf(!existsSync(cli))("writes key files the CLI can open", () => {
    const dir = mkdtempSync(join(tmpdir(), "qubits-ext-"));
    writeFileSync(join(dir, "k.json"), key.keystore);
    writeFileSync(join(dir, "pw"), `${PASSWORD}\n`);
    const shown = execFileSync(cli, ["key", "show", "--key", "k.json"], { cwd: dir }).toString();
    expect(shown).toContain(key.public_key);
    const address = execFileSync(cli, ["address", "--key", "k.json"], { cwd: dir }).toString().trim();
    expect(address).toBe(key.address);
    // The CLI can sign with it too, so the password and encryption match.
    writeFileSync(join(dir, "msg"), "hello");
    execFileSync(cli, ["sign", "--key", "k.json", "--message", "msg", "--password-file", "pw"], { cwd: dir });
  });
});

describe("signing", () => {
  it("signs a transfer and decodes exactly what was signed", () => {
    const bob = core.createKey("ml-dsa-65", PASSWORD).address;
    const payload = { transfer: { to: bob, asset: 0, amount: "1234" } };
    const signed = core.sign(status as StatusResponse, freshAccount(key.address), key.keystore, PASSWORD, "owner", payload);
    expect(signed.id).toMatch(/^[0-9a-f]{64}$/);

    const decoded = core.decodeTransaction(signed.transaction);
    expect(decoded.id).toBe(signed.id);
    expect(decoded.tx.payload).toEqual(payload);
    expect(decoded.tx.sender).toBe(key.address);
    expect(decoded.tx.genesis_hash).toBe(status.genesis_hash);
    expect(decoded.tx.valid_until_ms).toBeGreaterThan(Date.now());
    expect(decoded.tx.fee).toBe(signed.fee);
    expect(BigInt(signed.fee)).toBe(BigInt(status.min_fee_per_byte) * BigInt(signed.transaction.length / 2));
    expect(decoded.reveal?.keys).toEqual([key.public_key]);
    expect(decoded.signatures).toHaveLength(1);
  });

  it("refuses to sign with the wrong password or for someone else's account", () => {
    const other = core.createKey("ml-dsa-65", PASSWORD);
    const payload = { cancel_pending: { id: 0 } };
    expect(() =>
      core.sign(status, freshAccount(key.address), key.keystore, "wrong password!!", "owner", payload),
    ).toThrow("wrong password");
    expect(() => core.sign(status, freshAccount(other.address), key.keystore, PASSWORD, "owner", payload)).toThrow(
      "does not control",
    );
  });
});
