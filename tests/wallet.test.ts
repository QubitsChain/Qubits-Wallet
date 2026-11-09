// @vitest-environment node
// Wallet logic with the real WebAssembly core and a fake node.

import { describe, expect, it } from "vitest";

import type { AccountResponse, Receipt } from "../src/shared/api";
import { addressFromHex, addressToHex } from "../src/shared/address";
import * as f from "../src/shared/format";
import {
  allowedSite,
  BAD_REQUEST,
  changesOf,
  encodeArgs,
  gasFor,
  isUnlimited,
  NOT_CONNECTED,
  parseRequest,
  SiteError,
  UNSUPPORTED,
} from "../src/sites";
import status from "./fixtures/status.json";
import {
  failureOf,
  memoryStore,
  type Saved,
  type Token,
  TOKEN_TRANSFER_GAS,
  UNLOCK_MS,
  Wallet,
  WalletError,
} from "../src/wallet";
import { PASSWORD, testCore } from "./setup";

const core = testCore();
const NODE = "http://node.test";
const TOKEN = 10n ** 18n;

/** A fake node that knows one account and records submissions. */
function fakeNode(
  account: () => AccountResponse,
  chain: {
    views?: Record<string, Partial<Receipt> | number>;
    /** Replies by contract, for a chain of several. */
    contracts?: Record<string, Record<string, Partial<Receipt> | number>>;
    receipt?: Partial<Receipt>;
  } = {},
) {
  const submitted: string[] = [];
  const asked: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code });
    if (url.endsWith("/v1/status")) return json(status);
    if (url.includes("/v1/accounts/")) return json(account());
    if (url.endsWith("/v1/transactions") && init?.method === "POST") {
      const tx = JSON.parse(String(init.body)).transaction as string;
      submitted.push(tx);
      return json({ id: core.decodeTransaction(tx).id }, 202);
    }
    if (url.endsWith("/v1/contracts")) {
      if (!chain.contracts) return json({ error: "busy" }, 503);
      return json({ contracts: Object.keys(chain.contracts) });
    }
    if (url.endsWith("/view") && init?.method === "POST") {
      const contract = decodeURIComponent(url.split("/v1/contracts/")[1]!.replace("/view", ""));
      const fn = JSON.parse(String(init.body)).function as string;
      asked.push(`${contract}.${fn}`);
      const view = (chain.contracts?.[contract] ?? chain.views)?.[fn];
      if (view === undefined) return json({ error: "no contract at that address" }, 404);
      if (typeof view === "number") return json({ error: "busy" }, view);
      return json({ outcome: "done", gas_used: 1, output: "", events: [], contract: null, ...view });
    }
    if (url.includes("/v1/transactions/")) {
      const receipt = chain.receipt ?? null;
      return json({ id: "x", status: "included", block_height: 9, index: 0, transaction: {}, receipt });
    }
    return json({ error: "not found" }, 404);
  }) as typeof fetch;
  return { fetchImpl, submitted, asked };
}

function account(address: string, overrides: Partial<AccountResponse> = {}): AccountResponse {
  return {
    address,
    exists: true,
    nonce: 0,
    auth: null,
    vault: null,
    balances: [{ asset: 0, amount: "50000000000000000000" }],
    pending: [],
    ...overrides,
  };
}

/** A wallet with one freshly created key and a node that knows it. */
async function funded(overrides: Partial<AccountResponse> = {}, chain: Parameters<typeof fakeNode>[1] = {}) {
  const store = memoryStore();
  const created = await new Wallet(store, core, NODE).create("ml-dsa-65", PASSWORD, PASSWORD);
  const node = fakeNode(() => account(created.address, overrides), chain);
  const wallet = new Wallet(store, core, NODE, node.fetchImpl);
  const saved = (await wallet.load())!;
  return { wallet, saved, created, node };
}

describe("setup", () => {
  it("creates and stores an encrypted key", async () => {
    const wallet = new Wallet(memoryStore(), core, NODE);
    expect(await wallet.load()).toBeNull();
    await expect(wallet.create("ml-dsa-65", PASSWORD, "different password")).rejects.toThrow("different");
    await expect(wallet.create("ml-dsa-65", "short", "short")).rejects.toThrow("at least 12");

    const created = await wallet.create("ml-dsa-65", PASSWORD, PASSWORD);
    const saved = (await wallet.load())!;
    expect(saved.version).toBe(2);
    expect(saved.accounts).toHaveLength(1);
    expect(wallet.account(saved).info.address).toBe(created.address);
    expect(wallet.account(saved).name).toBe("Account 1");
    expect(saved.nodeUrl).toBe(NODE);
    expect(saved.accounts[0]!.keystore).not.toContain(PASSWORD);
    expect(saved.activity).toEqual([]);

    await wallet.forget();
    expect(await wallet.load()).toBeNull();
  });

  it("carries a version 1 wallet over", async () => {
    const store = memoryStore();
    const key = core.createKey("ml-dsa-65", PASSWORD);
    const { keystore, ...info } = key;
    await store.set("wallet", { keystore, info, nodeUrl: "https://old.example" });
    const wallet = new Wallet(store, core, NODE);
    const saved = (await wallet.load())!;
    expect(saved.version).toBe(2);
    expect(saved.nodeUrl).toBe("https://old.example");
    expect(saved.accounts).toEqual([{ name: "Account 1", keystore, info }]);
    expect(saved.active).toBe(0);
    // Written back in the new shape.
    expect(((await store.get("wallet")) as Saved).version).toBe(2);
  });

  it("imports key files and rejects other files", async () => {
    const source = core.createKey("ml-dsa-65", PASSWORD);
    const wallet = new Wallet(memoryStore(), core, NODE);
    await expect(wallet.importKeyFile('{"hello":1}')).rejects.toBeInstanceOf(WalletError);
    await expect(wallet.importKeyFile("not json")).rejects.toThrow("not a Qubits key file");
    expect((await wallet.importKeyFile(source.keystore, " Cold key ")).address).toBe(source.address);
    expect(wallet.account((await wallet.load())!).name).toBe("Cold key");
    await expect(wallet.importKeyFile(source.keystore)).rejects.toThrow("already here");
  });

  it("only accepts http(s) node addresses", async () => {
    const wallet = new Wallet(memoryStore(), core, NODE);
    const created = await wallet.importKeyFile(core.createKey("ml-dsa-65", PASSWORD).keystore);
    const saved = (await wallet.load())!;
    expect(created.address).toBe(wallet.account(saved).info.address);
    await expect(wallet.setNode(saved, "javascript:alert(1)")).rejects.toThrow("http");
    await expect(wallet.setNode(saved, "rpc.qubits.sh")).rejects.toThrow("http");
    expect((await wallet.setNode(saved, " https://rpc.example/ ")).nodeUrl).toBe("https://rpc.example");
  });
});

describe("accounts", () => {
  it("holds several keys, one in use", async () => {
    const wallet = new Wallet(memoryStore(), core, NODE);
    const first = await wallet.create("ml-dsa-65", PASSWORD, PASSWORD, "Main");
    const second = await wallet.create("ml-dsa-65", PASSWORD, PASSWORD);
    let saved = (await wallet.load())!;
    expect(saved.accounts.map((a) => a.name)).toEqual(["Main", "Account 2"]);
    expect(wallet.account(saved).info.address).toBe(second.address);

    saved = await wallet.switchAccount(saved, 0);
    expect(wallet.account(saved).info.address).toBe(first.address);
    await expect(wallet.switchAccount(saved, 5)).rejects.toThrow("No such account");

    saved = await wallet.renameAccount(saved, 1, "  Savings   vault ");
    expect(saved.accounts[1]!.name).toBe("Savings vault");
    expect((await wallet.renameAccount(saved, 1, "")).accounts[1]!.name).toBe("Savings vault");
    await expect(wallet.renameAccount(saved, 1, "x".repeat(33))).rejects.toThrow("under 32");

    saved = (await wallet.removeAccount(saved, 0))!;
    expect(saved.accounts).toHaveLength(1);
    expect(wallet.account(saved).info.address).toBe(second.address);
    expect(await wallet.removeAccount(saved, 0)).toBeNull();
    expect(await wallet.load()).toBeNull();
  });
});

describe("form input", () => {
  const wallet = new Wallet(memoryStore(), core, NODE);
  const someone = core.createKey("ml-dsa-65", PASSWORD);

  it("checks addresses as they are typed", () => {
    expect(wallet.checkAddress(` ${someone.address.toUpperCase()} `)).toEqual({ address: someone.address });
    expect(wallet.checkAddress("qb1typo")).toHaveProperty("error");
    expect(wallet.checkAddress("")).toHaveProperty("error");
  });

  it("builds transfers from what was typed", () => {
    expect(wallet.transfer(someone.address.toUpperCase(), "1,000")).toEqual({
      transfer: { to: someone.address, asset: 0, amount: "1000000000000000000000" },
    });
    expect(wallet.transfer(someone.address, "007")).toEqual({
      transfer: { to: someone.address, asset: 0, amount: "7000000000000000000" },
    });
    expect(wallet.transfer(someone.address, "1.5")).toEqual({
      transfer: { to: someone.address, asset: 0, amount: "1500000000000000000" },
    });
    expect(wallet.transfer(someone.address, ".000000000000000001")).toEqual({
      transfer: { to: someone.address, asset: 0, amount: "1" },
    });
    expect(() => wallet.transfer("qb1typo", "1")).toThrow("recipient address");
    for (const bad of ["0", "", "-5", "abc", "0.000000", "0.0000000000000000001", ".", "1.2.3"]) {
      expect(() => wallet.transfer(someone.address, bad)).toThrow("positive amount");
    }
  });
});

describe("the unlock", () => {
  it("keeps the password for a while, per account, and never on the wallet store", async () => {
    const store = memoryStore();
    const session = memoryStore();
    const wallet = new Wallet(store, core, NODE, undefined, session);
    const now = 1_700_000_000_000;
    const first = await wallet.create("ml-dsa-65", PASSWORD, PASSWORD, "First");
    let saved = (await wallet.load())!;
    // Creating a key unlocks it: the password was just typed twice.
    expect((await wallet.unlocked(saved))?.password).toBe(PASSWORD);
    expect(JSON.stringify(await store.get("wallet"))).not.toContain(PASSWORD);

    await wallet.lock();
    expect(await wallet.unlocked(saved, now)).toBeNull();
    await expect(wallet.unlock(saved, "not the password", now)).rejects.toThrow("Wrong password.");
    expect(await wallet.unlock(saved, PASSWORD, now)).toBe(now + UNLOCK_MS);
    expect(await wallet.unlocked(saved, now + UNLOCK_MS - 1)).toEqual({ password: PASSWORD, until: now + UNLOCK_MS });
    expect(await wallet.unlocked(saved, now + UNLOCK_MS)).toBeNull();
    // Lapsed once, it stays lapsed.
    expect(await wallet.unlocked(saved, now)).toBeNull();

    // Another account has its own unlock.
    await wallet.importKeyFile(core.createKey("ml-dsa-65", "another password!").keystore, "Second");
    saved = (await wallet.load())!;
    expect(wallet.account(saved).name).toBe("Second");
    expect(await wallet.unlocked(saved, now)).toBeNull();
    await wallet.unlock(saved, "another password!", now);
    expect(wallet.verify(saved, "another password!")).toBe(true);
    expect(wallet.verify(saved, PASSWORD)).toBe(false);
    saved = await wallet.switchAccount(saved, 0);
    expect(wallet.account(saved).info.address).toBe(first.address);
    expect(await wallet.unlocked(saved, now)).toBeNull();
  });
});

describe("sign, check, submit", () => {
  it("signs against the node's current state and submits only after preparing", async () => {
    const { wallet, saved, node } = await funded({ nonce: 0 });
    const payload = wallet.transfer(core.createKey("ml-dsa-65", PASSWORD).address, "25");
    const prepared = await wallet.prepare(saved, PASSWORD, "owner", payload);
    expect(prepared.decoded.tx.payload).toEqual(payload);
    expect(prepared.decoded.tx.nonce).toBe(0);
    expect(node.submitted).toHaveLength(0);

    const id = await wallet.submit(saved, prepared);
    expect(id).toBe(prepared.signed.id);
    expect(node.submitted).toEqual([prepared.signed.transaction]);
    expect(await wallet.waitIncluded(saved, id, 1_000, 10)).toEqual({ height: 9, failed: null });
  });

  it("previews what a signed transaction changes", async () => {
    const { wallet, created } = await funded();
    const alice = core.createKey("ml-dsa-65", PASSWORD).address;
    const saved = (await wallet.load())!;
    const plain = account(created.address);
    const prepared = await wallet.prepare(saved, PASSWORD, "owner", wallet.transfer(alice, "20"));
    const fee = BigInt(prepared.decoded.tx.fee);
    expect(fee).toBeGreaterThan(0n);

    const now = 1_700_000_000_000;
    let pv = wallet.preview(prepared, plain, now);
    expect(pv.fee).toBe(fee.toString());
    expect(pv.spend).toBe((20n * TOKEN + fee).toString());
    expect(pv.balanceAfter).toBe((50n * TOKEN - 20n * TOKEN - fee).toString());
    expect(pv.leavesAt).toBeNull();
    expect(pv.recipient).toEqual({ address: alice, self: false });

    const vault = account(created.address, { vault: { delay_ms: 60_000, recovery: null } });
    pv = wallet.preview(prepared, vault, now);
    expect(pv.leavesAt).toBe(now + 60_000);

    const cancel = await wallet.prepare(saved, PASSWORD, "owner", { cancel_pending: { id: 0 } });
    pv = wallet.preview(cancel, vault, now);
    expect(pv.recipient).toBeNull();
    expect(pv.leavesAt).toBeNull();
    expect(pv.spend).toBe(cancel.decoded.tx.fee);
  });

  it("estimates the fee and the most that can be sent", async () => {
    const { wallet, saved, created } = await funded();
    const fresh = account(created.address);
    const revealed = account(created.address, { auth: { threshold: 1, keys: [created.public_key] } });
    const first = wallet.feeEstimate(saved, status, fresh);
    const later = wallet.feeEstimate(saved, status, revealed);
    expect(first).toBeGreaterThan(later);
    expect(later).toBeGreaterThan(0n);
    // The estimate must cover the real fee, or "Max" would be rejected.
    const prepared = await wallet.prepare(saved, PASSWORD, "owner", wallet.transfer(created.address, "1"));
    expect(first).toBeGreaterThanOrEqual(BigInt(prepared.decoded.tx.fee));

    expect(BigInt(wallet.maxAmount(saved, status, fresh)) + first).toBe(50n * TOKEN);
    expect(wallet.maxAmount(saved, status, account(created.address, { balances: [{ asset: 0, amount: "10" }] }))).toBe("0");
  });

  it("remembers what was sent and what became of it", async () => {
    const { wallet, created } = await funded();
    const alice = core.createKey("ml-dsa-65", PASSWORD).address;
    let saved = (await wallet.load())!;
    const prepared = await wallet.prepare(saved, PASSWORD, "owner", wallet.transfer(alice, "20"));
    const now = 1_700_000_000_000;

    expect(wallet.lastSentTo(saved, alice)).toBeNull();
    saved = await wallet.record(saved, prepared, now);
    expect(wallet.activity(saved)).toMatchObject([
      { id: prepared.signed.id, at: now, account: created.address, status: "sent", fee: prepared.decoded.tx.fee },
    ]);
    expect(wallet.lastSentTo(saved, alice)).toBe(now);

    // The fake node says every transaction is in block 9.
    saved = await wallet.settle(saved);
    expect(wallet.activity(saved)[0]).toMatchObject({ status: "included", height: 9 });

    saved = await wallet.setActivity(saved, prepared.signed.id, "failed", { note: "not enough coins" });
    expect(wallet.activity(saved)[0]).toMatchObject({ status: "failed", note: "not enough coins" });
    expect(wallet.lastSentTo(saved, alice)).toBeNull();

    // Another account sees its own list.
    await wallet.create("ml-dsa-65", PASSWORD, PASSWORD, "Other");
    saved = (await wallet.load())!;
    expect(wallet.activity(saved)).toEqual([]);
  });

  it("marks a sent transaction failed once it has expired unseen", async () => {
    const { wallet, created } = await funded();
    const saved0 = (await wallet.load())!;
    const prepared = await wallet.prepare(saved0, PASSWORD, "owner", wallet.transfer(created.address, "1"));
    const lost = new Wallet(memoryStore(), core, NODE, (async () => new Response("{\"error\":\"unknown\"}", { status: 404 })) as typeof fetch);
    const start = 1_700_000_000_000;
    let saved = await lost.record({ ...saved0 }, prepared, start);
    saved = await lost.settle(saved, start + 10 * 60_000);
    expect(lost.activity(saved)[0]?.status).toBe("sent");
    saved = await lost.settle(saved, start + 70 * 60_000);
    expect(lost.activity(saved)[0]).toMatchObject({ status: "failed", note: "not included before it expired" });
  });

  it("explains signing failures", async () => {
    const { wallet, saved } = await funded();
    const payload = { cancel_pending: { id: 0 } };
    await expect(wallet.prepare(saved, "wrong password!", "owner", payload)).rejects.toThrow("Wrong password.");
    await expect(wallet.prepare(saved, PASSWORD, "recovery", payload)).rejects.toThrow("no recovery policy");
  });

  it("can sign with a one-off recovery key file", async () => {
    const store = memoryStore();
    const owner = await new Wallet(store, core, NODE).create("ml-dsa-65", PASSWORD, PASSWORD);
    const recovery = core.createKey("ml-dsa-65", PASSWORD);
    const node = fakeNode(() =>
      account(owner.address, {
        nonce: 3,
        auth: { threshold: 1, keys: [owner.public_key] },
        vault: { delay_ms: 60_000, recovery: { threshold: 1, keys: [recovery.public_key] } },
      }),
    );
    const wallet = new Wallet(store, core, NODE, node.fetchImpl);
    const saved = (await wallet.load())!;
    const prepared = await wallet.prepare(saved, PASSWORD, "recovery", { cancel_pending: { id: 2 } }, recovery.keystore);
    expect(prepared.decoded.tx.role).toBe("recovery");
    expect(prepared.decoded.tx.sender).toBe(owner.address);
    expect(prepared.decoded.tx.nonce).toBe(3);
    expect(prepared.decoded.reveal).toBeNull();
  });
});

const hex = (text: string) => Buffer.from(text).toString("hex");
const CONTRACT = "qb1vealhtjgvexg3cwye4vfj79ks33gj2f03kau8dne6uqwy5hur6esqyse9d";
const CONTRACT_BYTES = "667bfbae48664c88e1c4cd589978b6846289292f8dbbc3b679d700e252fc1eb3";
const EXAMPLE_VIEWS = {
  name: { output: hex("Example Token") },
  symbol: { output: hex("EXT") },
  decimals: { output: "0600000000000000" },
  // 1,500,000 in 16 little-endian bytes
  balance_of: { output: "60e31600000000000000000000000000" },
};
const EXAMPLE: Token = {
  chain: status.genesis_hash,
  contract: CONTRACT,
  name: "Example Token",
  symbol: "EXT",
  decimals: 6,
};

describe("tokens", () => {
  it("adds a token by asking its contract what it is", async () => {
    const { wallet, saved } = await funded({}, { views: EXAMPLE_VIEWS });
    const added = await wallet.addToken(saved, ` ${CONTRACT} `);
    expect(added.tokens).toEqual([EXAMPLE]);
    expect((await wallet.load())!.tokens).toEqual([EXAMPLE]);
    await expect(wallet.addToken(added, CONTRACT)).rejects.toThrow("already here");
  });

  it("refuses what isn't a token", async () => {
    const nothing = await funded({}, { views: {} });
    await expect(nothing.wallet.addToken(nothing.saved, CONTRACT)).rejects.toThrow("no token at that address");
    await expect(nothing.wallet.addToken(nothing.saved, "qb1nonsense")).rejects.toThrow("Check the token address");

    const other = await funded({}, { views: { ...EXAMPLE_VIEWS, symbol: { outcome: "invalid" } } });
    await expect(other.wallet.addToken(other.saved, CONTRACT)).rejects.toThrow("no token at that address");

    const down = await funded({}, { views: { ...EXAMPLE_VIEWS, symbol: 503 } });
    await expect(down.wallet.addToken(down.saved, CONTRACT)).rejects.toThrow("busy");
  });

  it("refuses a token that describes itself strangely", async () => {
    for (const views of [
      { symbol: { output: hex("q\nUSD") } },
      { symbol: { output: hex("A SYMBOL FAR TOO LONG") } },
      { name: { output: "" } },
      { decimals: { output: "2700000000000000" } },
    ]) {
      const { wallet, saved } = await funded({}, { views: { ...EXAMPLE_VIEWS, ...views } });
      await expect(wallet.addToken(saved, CONTRACT)).rejects.toThrow("like a token");
    }
  });

  it("keeps tokens to their chain, and forgets them on request", async () => {
    const { wallet, saved } = await funded({}, { views: EXAMPLE_VIEWS });
    const elsewhere = { ...EXAMPLE, chain: "00".repeat(32) };
    const both = { ...saved, tokens: [EXAMPLE, elsewhere] };
    expect(wallet.tokensOn(both, EXAMPLE.chain)).toEqual([EXAMPLE]);
    expect(await wallet.holdings(both, EXAMPLE.chain)).toEqual([{ token: EXAMPLE, balance: "1500000" }]);
    const fewer = await wallet.removeToken(both, EXAMPLE);
    expect(await wallet.holdings(fewer, EXAMPLE.chain)).toEqual([]);
    expect(wallet.tokensOn(fewer, elsewhere.chain)).toEqual([elsewhere]);
  });

  it("shows a token it can't read as unknown, not as zero", async () => {
    const { wallet, saved } = await funded({}, { views: { ...EXAMPLE_VIEWS, balance_of: 503 } });
    const withToken = { ...saved, tokens: [EXAMPLE] };
    expect(await wallet.holdings(withToken, EXAMPLE.chain)).toEqual([{ token: EXAMPLE, balance: null }]);
  });

  it("builds the exact call a token expects", async () => {
    const { wallet, created } = await funded();
    const { payload, sent } = wallet.tokenTransfer(created.address, "1.5", EXAMPLE);
    const words = addressToHex(created.address);
    expect(payload.call.contract).toBe(CONTRACT);
    expect(payload.call.function).toBe("transfer");
    expect(payload.call.amount).toBe("0");
    expect(payload.call.args).toBe(`${words}60e31600000000000000000000000000`);
    expect(sent).toEqual({ to: created.address, amount: "1500000", symbol: "EXT", decimals: 6 });
    expect(words).toHaveLength(64);

    const big = wallet.tokenTransfer(created.address, "340282366920938463463374607431768211455", { ...EXAMPLE, decimals: 0 });
    expect(big.payload.call.args.slice(64)).toBe("ff".repeat(16));

    const cents = wallet.tokenTransfer(created.address, "1.5", { ...EXAMPLE, decimals: 2 });
    expect(cents.sent.amount).toBe("150");
    expect(() => wallet.tokenTransfer(created.address, "1.555", { ...EXAMPLE, decimals: 2 })).toThrow("at most 2 decimals");
    expect(() => wallet.tokenTransfer("qb1nope", "1", EXAMPLE)).toThrow("recipient");
    expect(() => wallet.tokenTransfer(created.address, "0", EXAMPLE)).toThrow("positive");
  });

  it("signs a token transfer for no more than it said", async () => {
    const { wallet, saved, created } = await funded();
    const { status: chain, account: me } = await wallet.overview(saved);
    const { payload, sent } = wallet.tokenTransfer(created.address, "1", EXAMPLE);
    const prepared = await wallet.prepare(saved, PASSWORD, "owner", payload);
    const tx = prepared.decoded.tx;
    expect(tx.payload).toEqual(payload);
    const estimate = wallet.tokenFeeEstimate(saved, chain, me);
    expect(BigInt(tx.fee)).toBeLessThanOrEqual(estimate);
    expect(estimate - BigInt(tx.fee)).toBeLessThan(1_000n);
    expect(BigInt(tx.fee)).toBeGreaterThan(BigInt(TOKEN_TRANSFER_GAS / 16));

    const recorded = await wallet.record(saved, prepared, 1_000, { token: sent });
    expect(wallet.activity(recorded)[0]?.token).toEqual(sent);
    expect(wallet.lastSentTo(recorded, created.address)).toBe(1_000);
  });

  it("counts what a call cost in the end, not what it paid up front", async () => {
    const { wallet, saved, created } = await funded({}, { receipt: { gas_used: 180_000 } });
    const { payload, sent } = wallet.tokenTransfer(created.address, "1", EXAMPLE);
    const prepared = await wallet.prepare(saved, PASSWORD, "owner", payload);
    const recorded = await wallet.record(saved, prepared, Date.now(), { token: sent });
    const [entry] = wallet.activity(await wallet.settle(recorded));
    const unused = BigInt((TOKEN_TRANSFER_GAS - 180_000) / 16) * BigInt(status.min_fee_per_byte);
    expect(entry).toMatchObject({ status: "included", height: 9 });
    expect(BigInt(entry!.fee)).toBe(BigInt(prepared.decoded.tx.fee) - unused);
  });

  it("says a call from a vault waits", async () => {
    const vault = { delay_ms: 60_000, recovery: null };
    const { wallet, saved, created } = await funded({ vault });
    const { payload } = wallet.tokenTransfer(created.address, "1", EXAMPLE);
    const prepared = await wallet.prepare(saved, PASSWORD, "owner", payload);
    const { account: me } = await wallet.overview(saved);
    expect(wallet.preview(prepared, me, 1_000).leavesAt).toBe(61_000);
  });

  it("doesn't call a failed contract call sent", async () => {
    const reason = { reverted: { reason: hex("balance too low") } };
    const { wallet, saved, created } = await funded({}, { receipt: { outcome: reason, gas_used: 100_000 } });
    const { payload, sent } = wallet.tokenTransfer(created.address, "1", EXAMPLE);
    const prepared = await wallet.prepare(saved, PASSWORD, "owner", payload);
    const id = await wallet.submit(saved, prepared);
    expect(await wallet.waitIncluded(saved, id, 1_000, 10)).toEqual({ height: 9, failed: "balance too low" });

    const recorded = await wallet.record(saved, prepared, Date.now(), { token: sent });
    const [entry] = wallet.activity(await wallet.settle(recorded));
    expect(entry).toMatchObject({ status: "failed", height: 9, note: "balance too low" });
    expect(wallet.lastSentTo(await wallet.settle(recorded), created.address)).toBeNull();
  });

  it("says in words why a call failed", () => {
    const tx = (outcome: Receipt["outcome"]) =>
      ({ receipt: { outcome } }) as unknown as Parameters<typeof failureOf>[0];
    expect(failureOf(tx("done"))).toBeNull();
    expect(failureOf({ receipt: null } as unknown as Parameters<typeof failureOf>[0])).toBeNull();
    expect(failureOf(tx("out_of_gas"))).toContain("gas");
    expect(failureOf(tx("trapped"))).toContain("crashed");
    expect(failureOf(tx("invalid"))).toContain("no such function");
  });

  it("carries a wallet from before tokens over", async () => {
    const store = memoryStore();
    const first = new Wallet(store, core, NODE);
    await first.create("ml-dsa-65", PASSWORD, PASSWORD);
    const { tokens: _, ...older } = (await first.load())!;
    await store.set("wallet", older);
    expect((await first.load())!.tokens).toEqual([]);
  });

  it("shows and reads amounts at a token's own decimals", () => {
    expect(f.amount("1500000", 6)).toBe("1.5");
    expect(f.amount("150", 2)).toBe("1.5");
    expect(f.amount("1500", 0)).toBe("1,500");
    expect(f.amount("1", 18)).toBe("0.000000000000000001");
    expect(f.amount("1000000000000000000000", 18)).toBe("1,000");
    expect(f.baseUnits("1.5", 2)).toBe("150");
    expect(f.baseUnits("1.5", 0)).toBeNull();
    expect(f.baseUnits("7", 0)).toBe("7");
    expect(f.baseUnits("0.000000000000000001", 18)).toBe("1");
  });
});

describe("descriptions", () => {
  it("describes validator-set changes", async () => {
    const { payload } = await import("../src/shared/format");
    const validators = [
      { key: "01aa", payout: "qb1one" },
      { key: "01bb", payout: "qb1two" },
    ];
    expect(payload({ set_validators: { validators } })).toBe("Change the validator set to 2 validators");
    expect(payload({ claim_rewards: { payout: "qb1vealhtjgvexg3cwye4vfj79ks33gj2f03" } })).toMatch(/^Claim validator rewards for qb1vealhtj/);
  });
});

describe("finding tokens", () => {
  const OTHER = "qb1fynt55uaa8mhev04jp6awkj28dpty82tsgsy8hsxvdnql4pqth2q2rvp4u";
  const NOT_A_TOKEN = "qb1xgwtkh0d2hq0xz6mk9ux6vj7xz9ta20rr7qsy833ha4l5phws9esgrurtm";
  const none = { balance_of: { output: "00".repeat(16) } };
  const chain = (contracts: Record<string, Record<string, Partial<Receipt> | number>>) => ({ contracts });
  const THEIRS = { ...EXAMPLE_VIEWS, symbol: { output: hex("OTHER") }, ...none };
  const HERE = status.genesis_hash;

  it("shows what the account holds, without anyone adding it", async () => {
    const { wallet, saved } = await funded({}, chain({ [CONTRACT]: EXAMPLE_VIEWS, [OTHER]: THEIRS, [NOT_A_TOKEN]: {} }));
    const found = await wallet.discoverTokens(saved, HERE);
    expect(found.tokens.map((t) => t.symbol)).toEqual(["EXT", "OTHER"]);
    expect((await wallet.load())!.tokens).toHaveLength(2);
    const held = await wallet.holdings(found, HERE);
    expect(held).toEqual([{ token: { ...EXAMPLE, found: true }, balance: "1500000" }]);
  });

  it("asks each contract what it is once", async () => {
    const { wallet, saved, node } = await funded({}, chain({ [CONTRACT]: EXAMPLE_VIEWS, [NOT_A_TOKEN]: {} }));
    const first = await wallet.discoverTokens(saved, HERE);
    expect(first.notTokens).toEqual([{ chain: HERE, contract: NOT_A_TOKEN }]);
    node.asked.length = 0;
    expect(await wallet.discoverTokens(first, HERE)).toBe(first);
    expect(node.asked).toEqual([]);
  });

  it("leaves out a contract that describes itself strangely, and a node that is busy", async () => {
    const strange = { ...EXAMPLE_VIEWS, symbol: { output: hex("A SYMBOL FAR TOO LONG") } };
    const odd = await funded({}, chain({ [CONTRACT]: strange }));
    const looked = await odd.wallet.discoverTokens(odd.saved, HERE);
    expect(looked.tokens).toEqual([]);
    expect(looked.notTokens).toHaveLength(1);

    const busy = await funded({}, chain({ [CONTRACT]: { ...EXAMPLE_VIEWS, name: 503 } }));
    const later = await busy.wallet.discoverTokens(busy.saved, HERE);
    expect(later.tokens).toEqual([]);
    expect(later.notTokens).toEqual([]);

    const down = await funded();
    expect(await down.wallet.discoverTokens(down.saved, HERE)).toBe(down.saved);
  });

  it("keeps a hidden token hidden, and lets it be added back", async () => {
    const { wallet, saved } = await funded({}, chain({ [CONTRACT]: EXAMPLE_VIEWS }));
    const found = await wallet.discoverTokens(saved, HERE);
    const hidden = await wallet.removeToken(found, found.tokens[0]!);
    expect(await wallet.holdings(hidden, HERE)).toEqual([]);
    const again = await wallet.discoverTokens(hidden, HERE);
    expect(await wallet.holdings(again, HERE)).toEqual([]);
    const back = await wallet.addToken(again, CONTRACT);
    expect(await wallet.holdings(back, HERE)).toEqual([{ token: EXAMPLE, balance: "1500000" }]);
  });

  it("keeps a token added by hand, even at zero", async () => {
    const { wallet, saved } = await funded({}, chain({ [OTHER]: THEIRS }));
    const added = await wallet.addToken(saved, OTHER);
    const [held] = await wallet.holdings(added, HERE);
    expect(held?.balance).toBe("0");
    await expect(wallet.addToken(added, OTHER)).rejects.toThrow("already here");
  });

  it("shows a found token it can't read, rather than losing it", async () => {
    const { wallet, saved } = await funded({}, chain({ [CONTRACT]: { ...EXAMPLE_VIEWS, balance_of: 503 } }));
    const found = await wallet.discoverTokens(saved, HERE);
    expect((await wallet.holdings(found, HERE))[0]?.balance).toBeNull();
  });
});

describe("addresses", () => {
  it("reads and writes them the way the chain does", async () => {
    // from the Rust side: a token contract and the bytes it hashes to
    const created = await new Wallet(memoryStore(), core, NODE).create("ml-dsa-65", PASSWORD, PASSWORD);
    for (const address of [created.address, CONTRACT]) {
      const hex = addressToHex(address);
      expect(hex).toMatch(/^[0-9a-f]{64}$/);
      expect(addressFromHex(hex)).toBe(address);
      expect(core.checkAddress(addressFromHex(hex))).toBe(address);
    }
    expect(addressToHex(CONTRACT)).toBe(CONTRACT_BYTES);
  });

  it("refuses what isn't one", () => {
    const flipped = CONTRACT.slice(0, -1) + (CONTRACT.endsWith("d") ? "q" : "d");
    for (const bad of ["", "qb1", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", flipped, CONTRACT.toUpperCase(), "qb1b"]) {
      expect(() => addressToHex(bad), bad).toThrow();
    }
    expect(() => addressFromHex("00")).toThrow();
  });
});

describe("what a website may ask", () => {
  it("lets in qubits.sh and its subdomains, and nothing else", () => {
    for (const origin of ["https://qubits.sh", "https://app.qubits.sh", "https://a.b-c.qubits.sh", "https://x1.qubits.sh"]) {
      expect(allowedSite(origin), origin).toBe(true);
    }
    for (const origin of [
      undefined,
      "",
      "null",
      "http://qubits.sh",
      "http://app.qubits.sh",
      "https://qubits.sh:8443",
      "https://evilqubits.sh",
      "https://qubits.sh.evil.com",
      "https://qubits.shh",
      "https://qubits.sh.",
      "https://-bad.qubits.sh",
      "https://QUBITS.sh",
      "https://user@qubits.sh",
      "https://evil.com/https://qubits.sh",
      "chrome-extension://abc",
      "file://",
    ]) {
      expect(allowedSite(origin), String(origin)).toBe(false);
    }
  });

  it("encodes arguments as contracts read them", () => {
    expect(encodeArgs([CONTRACT])).toBe(CONTRACT_BYTES);
    expect(encodeArgs(["native"])).toBe("00".repeat(32));
    expect(encodeArgs(["1500000"])).toBe("60e31600000000000000000000000000");
    expect(encodeArgs(["u64:7"])).toBe("0700000000000000");
    expect(encodeArgs(["0xabcd"])).toBe("abcd");
    expect(encodeArgs(['"hi"'])).toBe("020000006869");
    expect(encodeArgs(["deadline:600"], 1_000)).toBe(`${(601_000).toString(16).padStart(6, "0").match(/../g)!.reverse().join("")}${"00".repeat(5)}`);
    expect(encodeArgs([CONTRACT, "5"])).toBe(`${CONTRACT_BYTES}05${"00".repeat(15)}`);
    expect(encodeArgs([])).toBe("");
  });

  it("refuses arguments it can't read, instead of guessing", () => {
    for (const args of [[5], [null], [["x"]], ["five"], ["-1"], ["0xabc"], ["0xZZ"], ["qb1nope"], [`u64:${2n ** 64n}`], [`${2n ** 128n}`]]) {
      expect(() => encodeArgs(args), JSON.stringify(args)).toThrow(SiteError);
    }
    expect(() => encodeArgs(["0x" + "ab".repeat(20_000)])).toThrow(SiteError);
  });

  it("takes the requests it knows, and checks every field", () => {
    const call = { contract: CONTRACT, function: "swap", args: ["5"], amount: "7" };
    expect(parseRequest({ method: "qb_connect" })).toEqual({ method: "qb_connect" });
    expect(parseRequest({ method: "qb_call", params: call })).toEqual({
      method: "qb_call",
      call: { contract: CONTRACT, function: "swap", args: `05${"00".repeat(15)}`, amount: "7" },
    });
    const code = (raw: unknown) => {
      try {
        parseRequest(raw);
      } catch (e) {
        return (e as SiteError).code;
      }
      return null;
    };
    expect(code({ method: "eth_sendTransaction" })).toBe(UNSUPPORTED);
    expect(code({ method: "__proto__" })).toBe(UNSUPPORTED);
    for (const raw of [
      null,
      "qb_connect",
      { method: "qb_call" },
      { method: "qb_call", params: { ...call, contract: "qb1nope" } },
      { method: "qb_call", params: { ...call, function: "init" } },
      { method: "qb_call", params: { ...call, function: "a b" } },
      { method: "qb_call", params: { ...call, function: "x".repeat(65) } },
      { method: "qb_call", params: { ...call, amount: 7 } },
      { method: "qb_call", params: { ...call, amount: "-1" } },
      { method: "qb_call", params: { ...call, amount: `${2n ** 128n}` } },
      { method: "qb_call", params: { ...call, args: "05" } },
      { method: "qb_transaction", params: { id: "nope" } },
    ]) {
      expect(code(raw), JSON.stringify(raw)).toBe(BAD_REQUEST);
    }
    expect(NOT_CONNECTED).toBe(4100);
  });

  it("reads what a call would change for this account, and nobody else's", () => {
    const me = CONTRACT;
    const other = addressFromHex("11".repeat(32));
    const token = addressFromHex("22".repeat(32));
    const hex = (s: string) => Buffer.from(s).toString("hex");
    const amount = (n: bigint) => encodeArgs([n.toString()]);
    const event = (topic: string, from: string, to: string, n: bigint) => ({
      contract: token,
      topic: hex(topic),
      data: addressToHex(from) + addressToHex(to) + amount(n),
    });
    const receipt = (events: Receipt["events"]): Receipt => ({ outcome: "done", gas_used: 1, output: "", events, contract: null });

    const spent = changesOf(receipt([event("transfer", me, other, 30n)]), me);
    expect(spent.tokens.get(token)).toBe(-30n);
    const got = changesOf(receipt([event("transfer", other, me, 30n), event("transfer", me, other, 10n)]), me);
    expect(got.tokens.get(token)).toBe(20n);
    expect(changesOf(receipt([event("transfer", other, other, 30n)]), me).tokens.size).toBe(0);
    expect(changesOf(receipt([event("transfer", me, me, 30n)]), me).tokens.size).toBe(0);

    const given = changesOf(receipt([event("approve", me, other, 2n ** 120n)]), me);
    expect(given.approvals).toEqual([{ token, spender: other, amount: 2n ** 120n }]);
    expect(isUnlimited(given.approvals[0]!.amount)).toBe(true);
    expect(isUnlimited(1_000_000n)).toBe(false);
    expect(changesOf(receipt([event("approve", other, me, 5n)]), me).approvals).toEqual([]);
    expect(changesOf(receipt([{ contract: token, topic: hex("transfer"), data: "abcd" }]), me).tokens.size).toBe(0);
  });

  it("gives a call room above what it used, up to the limit", () => {
    expect(gasFor(100_000, 5_000_000)).toBe(145_000);
    expect(gasFor(4_900_000, 5_000_000)).toBe(5_000_000);
  });

  it("remembers which site may see which account", async () => {
    const { wallet, saved, created } = await funded();
    expect(wallet.isConnected(saved, "https://app.qubits.sh")).toBe(false);
    const on = await wallet.connectSite(saved, "https://app.qubits.sh", 5);
    expect(on.sites).toEqual([{ origin: "https://app.qubits.sh", address: created.address, at: 5 }]);
    expect(wallet.isConnected(on, "https://app.qubits.sh")).toBe(true);
    expect(wallet.isConnected(on, "https://qubits.sh")).toBe(false);
    expect(await wallet.connectSite(on, "https://app.qubits.sh")).toBe(on);
    const off = await wallet.disconnectSite(on, on.sites[0]!);
    expect(wallet.isConnected(off, "https://app.qubits.sh")).toBe(false);
  });
});
