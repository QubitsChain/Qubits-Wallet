// What a website may ask of the wallet, as pure functions: who may ask at all, whether a request
// makes sense, and what a call would really do. Everything arriving here comes from a web page,
// so nothing in it is believed, and the same checks run before anything reaches the screen.

import { addressFromHex, addressToHex } from "./shared/address";
import type { Address, Hex, Receipt } from "./shared/api";

/**
 * Exactly qubits.sh and its subdomains, over https, on the default port. The manifest injects the
 * provider only there; this is the second lock, in case a page is ever somewhere it shouldn't be.
 */
const SITE = /^https:\/\/(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*qubits\.sh$/;

export function allowedSite(origin: string | undefined): origin is string {
  return origin !== undefined && SITE.test(origin);
}

/** Errors as a site sees them; the codes follow EIP-1193 where it has one. */
export const REFUSED = 4001;
export const NOT_CONNECTED = 4100;
export const UNSUPPORTED = 4200;
export const UNAVAILABLE = 4900;
export const WOULD_FAIL = 4300;
export const BAD_REQUEST = -32602;

export class SiteError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "SiteError";
  }
}

const bad = (message: string) => new SiteError(BAD_REQUEST, message);

export interface ContractRequest {
  contract: Address;
  function: string;
  /** Encoded, ready for the chain. */
  args: Hex;
  /** Native tokens going along, in base units. */
  amount: string;
}

export type SiteRequest =
  | { method: "qb_connect" }
  | { method: "qb_accounts" }
  | { method: "qb_chain" }
  | { method: "qb_transaction"; id: Hex }
  | { method: "qb_view"; call: ContractRequest }
  | { method: "qb_call"; call: ContractRequest };

const MAX_ARG_LENGTH = 32_768;

/**
 * Arguments the way the command line takes them: `qb1…` is an address, `native` the native
 * token, `5` a u128, `u64:5` a u64, `deadline:600` that many seconds from now, `"text"` bytes
 * with a length in front, `0xabcd` raw bytes. Concatenated, as contracts read them.
 */
export function encodeArgs(args: readonly unknown[], now = Date.now()): Hex {
  let hex = "";
  for (const arg of args) {
    if (typeof arg !== "string" || arg.length > MAX_ARG_LENGTH) throw bad("each argument is a string");
    hex += encodeArg(arg.trim(), now);
  }
  if (hex.length > MAX_ARG_LENGTH) throw bad("the arguments are too long");
  return hex;
}

function littleEndian(value: bigint, bytes: number): Hex {
  if (value >= 1n << BigInt(bytes * 8)) throw bad(`${value} doesn't fit in ${bytes} bytes`);
  let hex = "";
  for (let i = 0n; i < BigInt(bytes); i++) hex += ((value >> (i * 8n)) & 0xffn).toString(16).padStart(2, "0");
  return hex;
}

function encodeArg(arg: string, now: number): Hex {
  if (arg === "native") return "00".repeat(32);
  if (arg.startsWith("qb1")) {
    try {
      return addressToHex(arg);
    } catch (e) {
      throw bad((e as Error).message);
    }
  }
  if (/^0x(?:[0-9a-f]{2})*$/.test(arg)) return arg.slice(2);
  const number = /^u64:(\d{1,20})$/.exec(arg);
  if (number) return littleEndian(BigInt(number[1] as string), 8);
  const deadline = /^deadline:(\d{1,10})$/.exec(arg);
  if (deadline) return littleEndian(BigInt(now + Number(deadline[1]) * 1_000), 8);
  if (/^\d{1,39}$/.test(arg)) return littleEndian(BigInt(arg), 16);
  if (arg.length >= 2 && arg.startsWith('"') && arg.endsWith('"')) {
    const bytes = new TextEncoder().encode(arg.slice(1, -1));
    const body = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    return littleEndian(BigInt(bytes.length), 4) + body;
  }
  throw bad(`can't read the argument ${arg.slice(0, 40)}`);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw bad("expected an object");
  return value as Record<string, unknown>;
}

function contractRequest(raw: unknown): ContractRequest {
  const params = record(raw);
  const { contract, function: name, args = [], amount = "0" } = params;
  if (typeof contract !== "string") throw bad("contract is an address");
  try {
    addressToHex(contract);
  } catch (e) {
    throw bad((e as Error).message);
  }
  if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) {
    throw bad("function is a name");
  }
  if (name === "init") throw bad("init runs once, at deployment");
  if (!Array.isArray(args)) throw bad("args is a list");
  if (typeof amount !== "string" || !/^\d{1,39}$/.test(amount) || BigInt(amount) >= 1n << 128n) {
    throw bad("amount is a whole number of base units, as a string");
  }
  return { contract: contract.trim(), function: name, args: encodeArgs(args), amount };
}

/** A site's request as the wallet will treat it, or a `SiteError` saying why not. */
export function parseRequest(raw: unknown): SiteRequest {
  const { method, params } = record(raw);
  switch (method) {
    case "qb_connect":
    case "qb_accounts":
    case "qb_chain":
      return { method };
    case "qb_view":
    case "qb_call":
      return { method, call: contractRequest(params) };
    case "qb_transaction": {
      const { id } = record(params);
      if (typeof id !== "string" || !/^[0-9a-f]{64}$/.test(id)) throw bad("id is a transaction id");
      return { method, id };
    }
    default:
      throw new SiteError(UNSUPPORTED, `no such method: ${String(method).slice(0, 40)}`);
  }
}

/** What a simulated call would change for `me`, read from the chain's answer and nothing else. */
export interface Changes {
  /** Tokens by contract: positive comes in, negative goes out. */
  tokens: Map<Address, bigint>;
  /** Permissions this call gives away. */
  approvals: { token: Address; spender: Address; amount: bigint }[];
}

const TRANSFER = "7472616e73666572"; // "transfer"
const APPROVE = "617070726f7665"; // "approve"
const EVENT_LENGTH = 160; // two addresses and an amount, in hex

function amountOf(hex: Hex): bigint {
  let value = 0n;
  for (let i = hex.length - 2; i >= 0; i -= 2) value = (value << 8n) | BigInt(`0x${hex.slice(i, i + 2)}`);
  return value;
}

export function changesOf(receipt: Receipt, me: Address): Changes {
  const mine = addressToHex(me);
  const tokens = new Map<Address, bigint>();
  const approvals: Changes["approvals"] = [];
  for (const { contract, topic, data } of receipt.events) {
    if (data.length !== EVENT_LENGTH) continue;
    const [from, to, amount] = [data.slice(0, 64), data.slice(64, 128), amountOf(data.slice(128))];
    if (topic === TRANSFER) {
      const change = (to === mine ? amount : 0n) - (from === mine ? amount : 0n);
      if (change !== 0n) tokens.set(contract, (tokens.get(contract) ?? 0n) + change);
    } else if (topic === APPROVE && from === mine && amount > 0n) {
      approvals.push({ token: contract, spender: addressFromHex(to), amount });
    }
  }
  for (const [contract, change] of tokens) if (change === 0n) tokens.delete(contract);
  return { tokens, approvals };
}

/** So large that no real balance reaches it: a permission to take everything, now and later. */
export function isUnlimited(amount: bigint): boolean {
  return amount >= 1n << 100n;
}

/** Enough gas for what the simulation used, with room for state moving a little until it runs. */
export function gasFor(used: number, most: number): number {
  return Math.min(most, Math.ceil(used * 1.25) + 20_000);
}
