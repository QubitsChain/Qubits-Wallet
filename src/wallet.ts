// Wallet logic without UI: accounts and where their key files live, what was sent from here,
// talking to the node, and the sign → show → submit flow. Tested with a memory store,
// the real WebAssembly core and a fake or live node.

import { addressToHex } from "./shared/address";
import { ApiError, Client } from "./shared/api";
import { baseUnits, DECIMALS } from "./shared/format";
import type {
  AccountResponse,
  Address,
  Hex,
  Payload,
  Role,
  StatusResponse,
  TransactionResponse,
} from "./shared/api";
import type { Core, CreatedKey, Decoded, KeyInfo, Scheme, Signed } from "./core";

/** Persistent key-value storage. */
export interface Store {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

/** `chrome.storage.local`: stays on this computer, not synced to the Google account. */
export function chromeStore(): Store {
  return {
    get: async (key) => (await chrome.storage.local.get(key))[key],
    set: (key, value) => chrome.storage.local.set({ [key]: value }),
    remove: (key) => chrome.storage.local.remove(key),
  };
}

/** `localStorage`, for previewing the popup as a normal web page during development. */
export function localStore(): Store {
  return {
    get: async (key) => {
      const raw = localStorage.getItem(key);
      return raw === null ? undefined : JSON.parse(raw);
    },
    set: async (key, value) => localStorage.setItem(key, JSON.stringify(value)),
    remove: async (key) => localStorage.removeItem(key),
  };
}

/** `chrome.storage.session`: in memory only, gone when the browser closes. For the unlock. */
export function chromeSessionStore(): Store {
  return {
    get: async (key) => (await chrome.storage.session.get(key))[key],
    set: (key, value) => chrome.storage.session.set({ [key]: value }),
    remove: (key) => chrome.storage.session.remove(key),
  };
}

/** `sessionStorage`, the same for the popup previewed as a page. */
export function pageSessionStore(): Store {
  return {
    get: async (key) => {
      const raw = sessionStorage.getItem(key);
      return raw === null ? undefined : JSON.parse(raw);
    },
    set: async (key, value) => sessionStorage.setItem(key, JSON.stringify(value)),
    remove: async (key) => sessionStorage.removeItem(key),
  };
}

export function memoryStore(): Store {
  const data = new Map<string, unknown>();
  return {
    get: async (key) => data.get(key),
    set: async (key, value) => void data.set(key, value),
    remove: async (key) => void data.delete(key),
  };
}

const KEY = "wallet";
const SESSION_KEY = "unlocked";
/** How long the wallet stays unlocked after the password was given. */
export const UNLOCK_MS = 15 * 60_000;
const MAX_ACTIVITY = 200;
const MAX_NAME = 32;

/** A key this wallet holds: the encrypted key file and its public facts. */
export interface Account {
  name: string;
  keystore: string;
  info: KeyInfo;
}

export type ActivityStatus = "sent" | "included" | "failed";

/** Something signed and sent from this wallet, remembered so the user can see what happened. */
export interface Activity {
  id: Hex;
  at: number;
  account: Address;
  payload: Payload;
  role: Role;
  fee: string;
  status: ActivityStatus;
  height?: number;
  note?: string;
  /** What a token transfer sent: its payload only says which contract was called. */
  token?: TokenSend;
  /** The website that asked for this. */
  site?: string;
}

/** What the wallet keeps. */
export interface Saved {
  version: 2;
  accounts: Account[];
  active: number;
  nodeUrl: string;
  activity: Activity[];
  tokens: Token[];
  notTokens: NotToken[];
  /** Which account each website may see. */
  sites: Site[];
}

/** The first format: one key. Read once and carried over. */
interface SavedV1 {
  keystore: string;
  info: KeyInfo;
  nodeUrl: string;
}

/** Passwords kept while the wallet is unlocked, by address, each with when it lapses. */
type Unlocked = Record<Address, { password: string; until: number }>;

/** The one payload the wallet builds itself. */
export type Transfer = Extract<Payload, { transfer: unknown }>;
export type ContractCall = Extract<Payload, { call: unknown }>;

/** A website the user let see this account. */
export interface Site {
  origin: string;
  address: Address;
  at: number;
}

/** A token this wallet shows, on the chain with this genesis hash. */
export interface Token {
  chain: Hex;
  contract: Address;
  name: string;
  symbol: string;
  decimals: number;
  /** Found by the wallet, not added by the user: shown only while the account holds some. */
  found?: boolean;
  /** The user asked not to see it. Kept, or the next look would find it again. */
  hidden?: boolean;
}

/** A contract that isn't a token, so it needn't be asked again. */
export interface NotToken {
  chain: Hex;
  contract: Address;
}

/** A token and what the account holds of it, in base units; null if the node wouldn't say. */
export interface Held {
  token: Token;
  balance: string | null;
}

export interface TokenSend {
  to: Address;
  amount: string;
  symbol: string;
  decimals: number;
}

/** A signed transaction waiting for the user to confirm it. */
export interface Prepared {
  signed: Signed;
  /** Decoded from the signed bytes, so the confirmation shows exactly what will be sent. */
  decoded: Decoded;
}

/** What a signed transaction will do, for the user to check before it leaves. */
export interface Preview {
  /** base units leaving the account, fee included */
  spend: string;
  fee: string;
  balanceAfter: string;
  /** when the effect happens: now, or after the vault's delay */
  leavesAt: number | null;
  recipient: { address: Address; self: boolean } | null;
}

export class WalletError extends Error {
  override name = "WalletError";
}

function isUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function cleanName(name: string, fallback: string): string {
  const trimmed = name.trim().replace(/\s+/g, " ");
  if ([...trimmed].length > MAX_NAME) throw new WalletError(`Keep the name under ${MAX_NAME} characters.`);
  return trimmed || fallback;
}

/** Sizes that make up a one-signature transaction, for the fee before it is signed. */
const SIGNATURE_BYTES: Record<Scheme, number> = { "ml-dsa-65": 3_309, "slh-dsa-sha2-192s": 16_224 };
const PUBLIC_KEY_BYTES: Record<Scheme, number> = { "ml-dsa-65": 1_952, "slh-dsa-sha2-192s": 48 };
const TX_OVERHEAD_BYTES = 240;
/** Contract, function name's length, amount and gas limit of a contract call. */
const CALL_BYTES = 80;
/** Gas a token transfer is given. What it doesn't use comes back. */
export const TOKEN_TRANSFER_GAS = 500_000;
/** As `MAX_TX_GAS` in qubits-types. */
export const MAX_TX_GAS = 5_000_000;
const GAS_PER_BYTE = 16;
/** `limits::MAX_TX_BYTES` on the chain. */
const MAX_TX_BYTES = 288 * 1024;

/** A `u128` as a contract reads it: 16 bytes, little-endian. */
function u128Hex(value: bigint): Hex {
  let hex = "";
  for (let i = 0n; i < 16n; i++) hex += ((value >> (i * 8n)) & 0xffn).toString(16).padStart(2, "0");
  return hex;
}

/** Little-endian hex as a number, whatever its length. */
function fromLittleEndian(hex: Hex): bigint {
  let value = 0n;
  for (let i = hex.length - 2; i >= 0; i -= 2) value = (value << 8n) | BigInt(`0x${hex.slice(i, i + 2)}`);
  return value;
}

function textOf(hex: Hex): string {
  const bytes = new Uint8Array((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));
  return new TextDecoder().decode(bytes);
}

/** Names come from a contract, so they are kept short and printable. */
function readable(text: string, longest: number): boolean {
  // eslint-disable-next-line no-control-regex
  return text.length > 0 && text.length <= longest && !/[\u0000-\u001f\u007f]/.test(text);
}

/** What a transaction cost in the end: `fee` pays for all its gas, and the unused part comes back. */
function feePaid(entry: Activity, tx: TransactionResponse, minFeePerByte: number): string {
  if (!tx.receipt || !("call" in entry.payload)) return entry.fee;
  const unused = BigInt(entry.payload.call.gas_limit - tx.receipt.gas_used) / BigInt(GAS_PER_BYTE);
  return (BigInt(entry.fee) - unused * BigInt(minFeePerByte)).toString();
}

/** Why a transaction in a block didn't do what it was for, in words; null if it did. */
export function failureOf(tx: Pick<TransactionResponse, "receipt">): string | null {
  const outcome = tx.receipt?.outcome;
  if (!outcome || outcome === "done") return null;
  if (outcome === "out_of_gas") return "it ran out of gas";
  if (outcome === "trapped") return "the contract crashed";
  if (outcome === "invalid") return "the contract has no such function";
  return textOf(outcome.reverted.reason);
}
/** A transaction may be included for this long after signing (`VALID_FOR_MS` in core.ts). */
const VALID_FOR_MS = 60 * 60 * 1000;

export class Wallet {
  constructor(
    private readonly store: Store,
    private readonly core: Core,
    readonly defaultNode: string,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
    /** where the unlock lives: never the disk */
    private readonly session: Store = memoryStore(),
  ) {}

  /** Checks the password of the account in use and keeps it for `UNLOCK_MS`. Returns when it lapses. */
  async unlock(saved: Saved, password: string, now = Date.now()): Promise<number> {
    const me = this.account(saved);
    if (!this.verify(saved, password)) throw new WalletError("Wrong password.");
    return this.remember(me.info.address, password, now);
  }

  private async remember(address: Address, password: string, now: number): Promise<number> {
    const all = ((await this.session.get(SESSION_KEY)) as Unlocked | undefined) ?? {};
    const until = now + UNLOCK_MS;
    await this.session.set(SESSION_KEY, { ...all, [address]: { password, until } });
    return until;
  }

  /** The kept password of the account in use and when it lapses, or null once it has. */
  async unlocked(saved: Saved, now = Date.now()): Promise<{ password: string; until: number } | null> {
    const all = ((await this.session.get(SESSION_KEY)) as Unlocked | undefined) ?? {};
    const address = this.account(saved).info.address;
    const entry = all[address];
    if (!entry) return null;
    if (entry.until <= now) {
      delete all[address];
      await this.session.set(SESSION_KEY, all);
      return null;
    }
    return entry;
  }

  /** Forgets every kept password. */
  async lock(): Promise<void> {
    await this.session.remove(SESSION_KEY);
  }

  /** Whether `password` opens the key file of the account in use. */
  verify(saved: Saved, password: string): boolean {
    try {
      this.core.checkPassword(this.account(saved).keystore, password);
      return true;
    } catch {
      return false;
    }
  }

  async load(): Promise<Saved | null> {
    const raw = (await this.store.get(KEY)) as Saved | SavedV1 | undefined;
    if (!raw) return null;
    if ("version" in raw && raw.version === 2) return { ...raw, tokens: raw.tokens ?? [], notTokens: raw.notTokens ?? [], sites: raw.sites ?? [] };
    const v1 = raw as SavedV1;
    return this.save({
      version: 2,
      accounts: [{ name: "Account 1", keystore: v1.keystore, info: v1.info }],
      active: 0,
      nodeUrl: v1.nodeUrl,
      activity: [],
      tokens: [],
      notTokens: [],
      sites: [],
    });
  }

  private async save(saved: Saved): Promise<Saved> {
    await this.store.set(KEY, saved);
    return saved;
  }

  /** The account in use. */
  account(saved: Saved): Account {
    return saved.accounts[saved.active] ?? saved.accounts[0]!;
  }

  private async add(saved: Saved | null, account: Account): Promise<Saved> {
    const base: Saved = saved ?? {
      version: 2,
      accounts: [],
      active: 0,
      nodeUrl: this.defaultNode,
      activity: [],
      tokens: [],
      notTokens: [],
      sites: [],
    };
    if (base.accounts.some((a) => a.info.address === account.info.address)) {
      throw new WalletError("That key is already here.");
    }
    return this.save({ ...base, accounts: [...base.accounts, account], active: base.accounts.length });
  }

  /** Creates a key and makes it the account in use. */
  async create(scheme: Scheme, password: string, repeat: string, name = ""): Promise<CreatedKey> {
    if (password !== repeat) throw new WalletError("The two passwords are different.");
    if ([...password].length < this.core.minPasswordLength) {
      throw new WalletError(`Use a password of at least ${this.core.minPasswordLength} characters.`);
    }
    const saved = await this.load();
    const created = this.core.createKey(scheme, password);
    const { keystore, ...info } = created;
    await this.add(saved, { name: cleanName(name, `Account ${(saved?.accounts.length ?? 0) + 1}`), keystore, info });
    await this.remember(created.address, password, Date.now());
    return created;
  }

  /** Imports a key file made by `qubits key new` or exported from this wallet. */
  async importKeyFile(text: string, name = ""): Promise<KeyInfo> {
    let info: KeyInfo;
    try {
      info = this.core.keyInfo(text);
    } catch (e) {
      throw new WalletError(`This is not a Qubits key file: ${(e as Error).message}`);
    }
    const saved = await this.load();
    await this.add(saved, { name: cleanName(name, `Account ${(saved?.accounts.length ?? 0) + 1}`), keystore: text, info });
    return info;
  }

  async switchAccount(saved: Saved, index: number): Promise<Saved> {
    if (!saved.accounts[index]) throw new WalletError("No such account.");
    return this.save({ ...saved, active: index });
  }

  async renameAccount(saved: Saved, index: number, name: string): Promise<Saved> {
    const account = saved.accounts[index];
    if (!account) throw new WalletError("No such account.");
    const accounts = saved.accounts.map((a, i) => (i === index ? { ...a, name: cleanName(name, a.name) } : a));
    return this.save({ ...saved, accounts });
  }

  /** Drops a key from this browser. The last one empties the wallet. */
  async removeAccount(saved: Saved, index: number): Promise<Saved | null> {
    if (!saved.accounts[index]) throw new WalletError("No such account.");
    const accounts = saved.accounts.filter((_, i) => i !== index);
    if (accounts.length === 0) {
      await this.forget();
      return null;
    }
    const active = index < saved.active ? saved.active - 1 : Math.min(saved.active, accounts.length - 1);
    return this.save({ ...saved, accounts, active });
  }

  async setNode(saved: Saved, url: string): Promise<Saved> {
    const trimmed = url.trim().replace(/\/+$/, "");
    if (!isUrl(trimmed)) throw new WalletError("Enter a node address starting with http:// or https://.");
    return this.save({ ...saved, nodeUrl: trimmed });
  }

  async forget(): Promise<void> {
    await this.store.remove(KEY);
  }

  /** What was sent from the account in use, newest first. */
  activity(saved: Saved): Activity[] {
    const address = this.account(saved).info.address;
    return saved.activity.filter((a) => a.account === address).sort((a, b) => b.at - a.at);
  }

  /** Remembers a transaction that just left. */
  async record(
    saved: Saved,
    prepared: Prepared,
    now = Date.now(),
    extra: { token?: TokenSend; site?: string } = {},
  ): Promise<Saved> {
    const tx = prepared.decoded.tx;
    const entry: Activity = {
      id: prepared.signed.id,
      at: now,
      account: tx.sender,
      payload: tx.payload,
      role: tx.role,
      fee: tx.fee,
      status: "sent",
      ...extra,
    };
    const activity = [entry, ...saved.activity.filter((a) => a.id !== entry.id)].slice(0, MAX_ACTIVITY);
    return this.save({ ...saved, activity });
  }

  async setActivity(
    saved: Saved,
    id: Hex,
    status: ActivityStatus,
    detail: { height?: number; note?: string; fee?: string } = {},
  ): Promise<Saved> {
    const activity = saved.activity.map((a) => (a.id === id ? { ...a, status, ...detail } : a));
    return this.save({ ...saved, activity });
  }

  /** Asks the node about the newest transactions sent from here that no block has been seen for. */
  async settle(saved: Saved, now = Date.now()): Promise<Saved> {
    const waiting = saved.activity.filter((a) => a.status === "sent").slice(0, 5);
    if (waiting.length === 0) return saved;
    const client = this.client(saved);
    let current = saved;
    for (const entry of waiting) {
      try {
        const tx = await client.transaction(entry.id);
        if (tx.status === "included" && tx.block_height !== null) {
          const failed = failureOf(tx);
          const { min_fee_per_byte: rate } = await client.status();
          const detail = {
            height: tx.block_height,
            fee: feePaid(entry, tx, rate),
            ...(failed ? { note: failed } : {}),
          };
          current = await this.setActivity(current, entry.id, failed ? "failed" : "included", detail);
        }
      } catch {
        if (now - entry.at > VALID_FOR_MS + 5 * 60_000) {
          current = await this.setActivity(current, entry.id, "failed", { note: "not included before it expired" });
        }
        // Otherwise the node doesn't know it yet, or is busy: ask again next time.
      }
    }
    return current;
  }

  /** When something last went from this wallet to `address`, or null if nothing did. */
  lastSentTo(saved: Saved, address: Address): number | null {
    const times = saved.activity
      .filter((a) => {
        const to = a.token?.to ?? ("transfer" in a.payload ? a.payload.transfer.to : null);
        return a.status !== "failed" && to === address;
      })
      .map((a) => a.at);
    return times.length ? Math.max(...times) : null;
  }

  client(saved: Saved): Client {
    return new Client(saved.nodeUrl, this.fetchImpl);
  }

  async overview(saved: Saved): Promise<{ status: StatusResponse; account: AccountResponse }> {
    const client = this.client(saved);
    const address = this.account(saved).info.address;
    const [status, account] = await Promise.all([client.status(), client.account(address)]);
    return { status, account };
  }

  /**
   * The fee a one-signature transaction from this account will roughly cost, in base units. The
   * first transaction also carries the public key, so it costs more.
   */
  feeEstimate(saved: Saved, status: StatusResponse, account: AccountResponse): bigint {
    const scheme = this.account(saved).info.scheme;
    let bytes = SIGNATURE_BYTES[scheme] + TX_OVERHEAD_BYTES;
    if (account.auth === null) bytes += PUBLIC_KEY_BYTES[scheme] + 8;
    return BigInt(status.min_fee_per_byte) * BigInt(bytes);
  }

  /**
   * The most a token transfer can cost in the chain's own coin: what it pays up front. The gas
   * it doesn't use comes back, so it usually ends up costing less.
   */
  tokenFeeEstimate(saved: Saved, status: StatusResponse, account: AccountResponse): bigint {
    const call = { contract: "", function: "transfer", args: "00".repeat(48), amount: "0", gas_limit: TOKEN_TRANSFER_GAS };
    return this.callFeeEstimate(saved, status, account, call);
  }

  /** The same for any contract call: the most it can cost, paid up front. */
  callFeeEstimate(
    saved: Saved,
    status: StatusResponse,
    account: AccountResponse,
    call: ContractCall["call"],
  ): bigint {
    const bytes = BigInt(CALL_BYTES + call.function.length + call.args.length / 2);
    const gas = BigInt(Math.ceil(call.gas_limit / GAS_PER_BYTE));
    return this.feeEstimate(saved, status, account) + BigInt(status.min_fee_per_byte) * (bytes + gas);
  }

  /** What a vault with a recovery policy can't spend: the fee of the largest transaction, kept for recovery. */
  recoveryReserve(status: StatusResponse, account: AccountResponse): bigint {
    return account.vault?.recovery ? BigInt(status.min_fee_per_byte) * BigInt(MAX_TX_BYTES) : 0n;
  }

  /** The most that can be sent, leaving room for the fee; "0" when there is nothing to send. */
  maxAmount(saved: Saved, status: StatusResponse, account: AccountResponse): string {
    const balance = BigInt(account.balances.find((b) => b.asset === 0)?.amount ?? "0");
    const left = balance - this.feeEstimate(saved, status, account) - this.recoveryReserve(status, account);
    return left > 0n ? left.toString() : "0";
  }

  /**
   * Builds and signs a transaction from the account in use. `signerKeystore` lets a different
   * key sign, such as the vault's recovery key loaded just for this transaction.
   */
  async prepare(
    saved: Saved,
    password: string,
    role: Role,
    payload: Payload,
    signerKeystore: string = this.account(saved).keystore,
  ): Promise<Prepared> {
    const { status, account } = await this.overview(saved);
    let signed: Signed;
    try {
      signed = this.core.sign(status, account, signerKeystore, password, role, payload);
    } catch (e) {
      const message = (e as Error).message;
      throw new WalletError(message.charAt(0).toUpperCase() + message.slice(1) + ".");
    }
    return { signed, decoded: this.core.decodeTransaction(signed.transaction) };
  }

  /** What `prepared` will do to the account, from the node's current view of it. */
  preview(prepared: Prepared, account: AccountResponse, now = Date.now()): Preview {
    const tx = prepared.decoded.tx;
    const balance = BigInt(account.balances.find((b) => b.asset === 0)?.amount ?? "0");
    const fee = BigInt(tx.fee);
    const moved = "transfer" in tx.payload ? tx.payload.transfer.amount : "call" in tx.payload ? tx.payload.call.amount : "0";
    const amount = BigInt(moved);
    const delayed =
      tx.role === "owner" && account.vault !== null && ("transfer" in tx.payload || "call" in tx.payload);
    const recipient = "transfer" in tx.payload ? tx.payload.transfer.to : null;
    return {
      spend: (amount + fee).toString(),
      fee: fee.toString(),
      balanceAfter: (balance - amount - fee).toString(),
      leavesAt: delayed ? now + (account.vault?.delay_ms ?? 0) : null,
      recipient: recipient === null ? null : { address: recipient, self: recipient === tx.sender },
    };
  }

  async submit(saved: Saved, prepared: Prepared): Promise<string> {
    return this.client(saved).submit(prepared.signed.transaction);
  }

  /** Polls until the transaction is in a block. It can be in one and still have failed. */
  async waitIncluded(
    saved: Saved,
    id: string,
    timeoutMs = 60_000,
    intervalMs = 500,
  ): Promise<{ height: number; failed: string | null }> {
    const client = this.client(saved);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const tx = await client.transaction(id);
        if (tx.status === "included" && tx.block_height !== null) {
          return { height: tx.block_height, failed: failureOf(tx) };
        }
      } catch {
        // Not known yet or the node is briefly unavailable: keep polling.
      }
      if (Date.now() > deadline) throw new WalletError("The transaction was not included in time.");
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  isConnected(saved: Saved, origin: string): boolean {
    const address = this.account(saved).info.address;
    return saved.sites.some((s) => s.origin === origin && s.address === address);
  }

  /** Lets a website see the account in use. */
  async connectSite(saved: Saved, origin: string, now = Date.now()): Promise<Saved> {
    if (this.isConnected(saved, origin)) return saved;
    const site = { origin, address: this.account(saved).info.address, at: now };
    return this.save({ ...saved, sites: [...saved.sites, site] });
  }

  async disconnectSite(saved: Saved, site: Site): Promise<Saved> {
    const keep = (s: Site) => s.origin !== site.origin || s.address !== site.address;
    return this.save({ ...saved, sites: saved.sites.filter(keep) });
  }

  /** The tokens in this wallet that live on the chain with this genesis hash. */
  tokensOn(saved: Saved, chain: Hex): Token[] {
    return saved.tokens.filter((t) => t.chain === chain);
  }

  /** Adds a token by its contract's address, asking the contract what it is. */
  async addToken(saved: Saved, text: string): Promise<Saved> {
    const checked = this.checkAddress(text);
    if ("error" in checked) throw new WalletError(`Check the token address: ${checked.error}.`);
    const { genesis_hash: chain } = await this.client(saved).status();
    const known = this.tokensOn(saved, chain).find((t) => t.contract === checked.address);
    if (known && !known.found && !known.hidden) throw new WalletError("That token is already here.");
    const token = known ?? (await this.tokenInfo(saved, chain, checked.address));
    if (!token) throw new WalletError("There is no token at that address on this chain.");
    // added by hand, it stays even at zero, whatever became of it before
    const { found: _found, hidden: _hidden, ...kept } = token;
    const others = saved.tokens.filter((t) => t !== known);
    return this.save({ ...saved, tokens: [...others, kept] });
  }

  /**
   * Looks for tokens the chain has that this wallet doesn't know yet, so that what an account
   * holds shows without anyone adding it. Each contract is asked once. Never fails: not finding
   * anything new is no reason to stop opening the wallet.
   */
  async discoverTokens(saved: Saved, chain: Hex): Promise<Saved> {
    let all: Address[];
    try {
      all = await this.client(saved).contracts();
    } catch {
      return saved;
    }
    const seen = new Set([
      ...this.tokensOn(saved, chain).map((t) => t.contract),
      ...saved.notTokens.filter((n) => n.chain === chain).map((n) => n.contract),
    ]);
    const tokens = [...saved.tokens];
    const notTokens = [...saved.notTokens];
    for (const contract of all.filter((c) => !seen.has(c))) {
      try {
        const token = await this.tokenInfo(saved, chain, contract);
        if (token) tokens.push({ ...token, found: true });
        else notTokens.push({ chain, contract });
      } catch (e) {
        // a contract that describes itself strangely is no token; the node being busy says nothing
        if (e instanceof WalletError) notTokens.push({ chain, contract });
      }
    }
    if (tokens.length === saved.tokens.length && notTokens.length === saved.notTokens.length) return saved;
    return this.save({ ...saved, tokens, notTokens });
  }

  /** What a contract says it is, or null if it isn't a token. */
  async tokenInfo(saved: Saved, chain: Hex, contract: Address): Promise<Token | null> {
    const client = this.client(saved);
    const ask = async (fn: string): Promise<Hex | null> => {
      try {
        const receipt = await client.view(contract, fn);
        return receipt.outcome === "done" ? receipt.output : null;
      } catch (e) {
        if (e instanceof ApiError && e.status !== 404 && e.status !== 400) throw e;
        return null;
      }
    };
    const [name, symbol, decimals] = await Promise.all([ask("name"), ask("symbol"), ask("decimals")]);
    if (name === null || symbol === null || decimals === null) return null;
    const token: Token = {
      chain,
      contract,
      name: textOf(name),
      symbol: textOf(symbol),
      decimals: Number(fromLittleEndian(decimals)),
    };
    if (!readable(token.name, 40) || !readable(token.symbol, 12) || token.decimals > 38) {
      throw new WalletError("That contract doesn't describe itself like a token.");
    }
    return token;
  }

  async removeToken(saved: Saved, token: Token): Promise<Saved> {
    const same = (t: Token) => t.chain === token.chain && t.contract === token.contract;
    return this.save({ ...saved, tokens: saved.tokens.map((t) => (same(t) ? { ...t, hidden: true } : t)) });
  }

  /**
   * The tokens to show on this chain, with what the account in use holds of them: what the user
   * added, and what the wallet found, while there is any of it.
   */
  async holdings(saved: Saved, chain: Hex): Promise<Held[]> {
    const client = this.client(saved);
    const who = addressToHex(this.account(saved).info.address);
    const all = await Promise.all(
      this.tokensOn(saved, chain)
        .filter((token) => !token.hidden)
        .map(async (token) => {
          try {
            const receipt = await client.view(token.contract, "balance_of", who);
            const balance = receipt.outcome === "done" ? fromLittleEndian(receipt.output).toString() : null;
            return { token, balance };
          } catch {
            return { token, balance: null };
          }
        }),
    );
    return all.filter(({ token, balance }) => !token.found || balance !== "0");
  }

  /** `token.transfer(to, amount)`, and what to remember about it. */
  tokenTransfer(to: string, amount: string, token: Token): { payload: ContractCall; sent: TokenSend } {
    const checked = this.checkAddress(to);
    if ("error" in checked) throw new WalletError(`Check the recipient address: ${checked.error}.`);
    const units = baseUnits(amount, token.decimals);
    if (units === null) {
      throw new WalletError(`Enter a positive amount with at most ${token.decimals} decimals.`);
    }
    const payload: ContractCall = {
      call: {
        contract: token.contract,
        function: "transfer",
        args: addressToHex(checked.address) + u128Hex(BigInt(units)),
        amount: "0",
        gas_limit: TOKEN_TRANSFER_GAS,
      },
    };
    const { symbol, decimals } = token;
    return { payload, sent: { to: checked.address, amount: units, symbol, decimals } };
  }

  /** The canonical address, or why the text isn't one. */
  checkAddress(text: string): { address: Address } | { error: string } {
    try {
      return { address: this.core.checkAddress(text.trim()) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  transfer(to: string, amount: string): Transfer {
    const checked = this.checkAddress(to);
    if ("error" in checked) throw new WalletError(`Check the recipient address: ${checked.error}.`);
    const units = baseUnits(amount);
    if (units === null) {
      throw new WalletError(`Enter a positive amount with at most ${DECIMALS} decimals.`);
    }
    return { transfer: { to: checked.address, asset: 0, amount: units } };
  }
}
