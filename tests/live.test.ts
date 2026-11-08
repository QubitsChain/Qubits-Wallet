// @vitest-environment node
// Against a running node, with funded key files:
//   QUBITS_LIVE_RPC=http://127.0.0.1:8545 \
//   QUBITS_LIVE_KEY=bob.json QUBITS_LIVE_VAULT_KEY=alice.json QUBITS_LIVE_PASSWORD=... npm test
// QUBITS_LIVE_KEY must be a funded plain account; QUBITS_LIVE_VAULT_KEY a funded vault.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { memoryStore, Wallet } from "../src/wallet";
import { PASSWORD, testCore } from "./setup";

const rpc = process.env.QUBITS_LIVE_RPC;
const keyFile = process.env.QUBITS_LIVE_KEY;
const vaultFile = process.env.QUBITS_LIVE_VAULT_KEY;
const password = process.env.QUBITS_LIVE_PASSWORD ?? "";
const core = testCore();

async function walletFor(file: string) {
  const wallet = new Wallet(memoryStore(), core, rpc!);
  await wallet.importKeyFile(readFileSync(file, "utf8"));
  return { wallet, saved: (await wallet.load())! };
}

describe.skipIf(!rpc || !keyFile)("live node: transfer", () => {
  it("sends coins that arrive", async () => {
    const { wallet, saved } = await walletFor(keyFile!);
    const recipient = core.createKey("ml-dsa-65", PASSWORD).address;
    const prepared = await wallet.prepare(saved, password, "owner", wallet.transfer(recipient, "0.000000000000000777"));
    const id = await wallet.submit(saved, prepared);
    const { height } = await wallet.waitIncluded(saved, id, 30_000, 200);
    expect(height).toBeGreaterThan(0);
    const arrived = await wallet.client(saved).account(recipient);
    expect(arrived.balances).toEqual([{ asset: 0, amount: "777" }]);
  });
});

describe.skipIf(!rpc || !vaultFile)("live node: vault", () => {
  it("queues a vault transfer and cancels it", async () => {
    const { wallet, saved } = await walletFor(vaultFile!);
    const before = (await wallet.overview(saved)).account;
    expect(before.vault).not.toBeNull();

    const send = await wallet.prepare(saved, password, "owner", wallet.transfer(wallet.account(saved).info.address, "0.000000000000000005"));
    await wallet.waitIncluded(saved, await wallet.submit(saved, send), 30_000, 200);
    const queued = (await wallet.overview(saved)).account.pending;
    expect(queued.length).toBe(before.pending.length + 1);
    const id = queued[queued.length - 1]!.id;

    const cancel = await wallet.prepare(saved, password, "owner", { cancel_pending: { id } });
    await wallet.waitIncluded(saved, await wallet.submit(saved, cancel), 30_000, 200);
    const after = (await wallet.overview(saved)).account.pending;
    expect(after.map((p) => p.id)).not.toContain(id);
  });
});
