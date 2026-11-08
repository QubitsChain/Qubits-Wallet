// Formatting helpers for chain data. All pure, so they are unit tested.

import type { AuthPolicy, DelayedAction, Hex, Payload, VaultPolicy } from "./api";

const SCHEMES: Record<string, { name: string; signatureBytes: number }> = {
  "01": { name: "ML-DSA-65", signatureBytes: 3309 },
  "02": { name: "SLH-DSA-SHA2-192s", signatureBytes: 16224 },
};

/** Scheme name of a scheme-tagged key or signature (first byte). */
export function schemeOf(tagged: Hex): string {
  return SCHEMES[tagged.slice(0, 2)]?.name ?? `unknown scheme 0x${tagged.slice(0, 2)}`;
}

/** Byte length of hex, without the one-byte scheme tag. */
export function rawBytes(tagged: Hex): number {
  return Math.max(0, tagged.length / 2 - 1);
}

/** Decimal places of the native token, as `NATIVE_DECIMALS` in qubits-types. */
export const DECIMALS = 18;

/** Base units as tokens: "1234567" → "1.234567", "2000000000" → "2,000". Works beyond 2^53. */
export function amount(value: string, decimals = DECIMALS): string {
  if (!/^\d+$/.test(value)) return value;
  const digits = value.padStart(decimals + 1, "0");
  const cut = digits.length - decimals;
  const whole = digits.slice(0, cut).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = digits.slice(cut).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/**
 * An amount to read, not to count: balances and fees, where 18 digits say nothing. Six decimals,
 * or four significant digits of something smaller, rounded down. What is being sent is never
 * shown this way: that stays `amount`, to the last digit.
 */
export function brief(value: string, decimals = DECIMALS): string {
  const [whole = "", fraction = ""] = amount(value, decimals).split(".");
  const firstDigit = fraction.search(/[1-9]/);
  const keep = whole === "0" ? Math.max(6, firstDigit + 4) : 6;
  const kept = fraction.slice(0, keep).replace(/0+$/, "");
  return kept ? `${whole}.${kept}` : whole;
}

/** Tokens as base units: "1.5" → "1500000…". Null unless positive, within the token's decimals. */
export function baseUnits(tokens: string, decimals = DECIMALS): string | null {
  const match = /^(\d*)(?:\.(\d*))?$/.exec(tokens.trim().replace(/[,_\s]/g, ""));
  if (!match || (!match[1] && !match[2]) || (match[2]?.length ?? 0) > decimals) return null;
  const units = (match[1] + (match[2] ?? "").padEnd(decimals, "0")).replace(/^0+/, "");
  return units || null;
}

export function integer(value: number): string {
  return value.toLocaleString("en-US");
}

/** "a1b2c3d4…e5f6" for long hex; addresses keep their prefix: "qb1abcd…wxyz". */
export function short(value: string, head = 8, tail = 6): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** "3 days 4 hours", "2 hours 5 minutes", "45 seconds". Two largest units. */
export function duration(ms: number): string {
  const units: [string, number][] = [
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
    ["second", 1_000],
  ];
  if (ms < 1_000) return "less than a second";
  const parts: string[] = [];
  let rest = ms;
  for (const [name, size] of units) {
    const n = Math.floor(rest / size);
    if (n > 0 && parts.length < 2) {
      parts.push(`${n} ${name}${n === 1 ? "" : "s"}`);
      rest -= n * size;
    } else if (parts.length > 0) {
      break;
    }
  }
  return parts.join(" ");
}

/** "5 minutes ago" relative to `now`. */
export function ago(timestampMs: number, nowMs: number): string {
  const diff = nowMs - timestampMs;
  if (diff < 1_000) return "just now";
  return `${duration(diff)} ago`;
}

export function dateTime(timestampMs: number): string {
  return new Date(timestampMs).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

export function policy(p: AuthPolicy): string {
  const schemes = [...new Set(p.keys.map(schemeOf))].join(" and ");
  if (p.keys.length === 1) return `1 ${schemes} key`;
  return `${p.threshold} of ${p.keys.length} keys (${schemes})`;
}

export function vault(v: VaultPolicy | null): string {
  if (!v) return "not a vault";
  const recovery = v.recovery ? `, recovery by ${policy(v.recovery)}` : ", no recovery key";
  return `transfers wait ${duration(v.delay_ms)}${recovery}`;
}

function assetLabel(asset: number): string {
  return asset === 0 ? "" : ` of asset ${asset}`;
}

/** One-line description of what a transaction does. */
export function payload(p: Payload): string {
  if ("transfer" in p) {
    const t = p.transfer;
    return `Send ${amount(t.amount)}${assetLabel(t.asset)} to ${short(t.to, 10, 6)}`;
  }
  if ("set_auth" in p) return `Replace owner keys with ${policy(p.set_auth.auth)}`;
  if ("set_vault" in p) {
    return p.set_vault.vault ? `Make vault: ${vault(p.set_vault.vault)}` : "Stop being a vault";
  }
  if ("cancel_pending" in p) return `Cancel pending action ${p.cancel_pending.id}`;
  if ("set_validators" in p) {
    const n = p.set_validators.validators.length;
    return `Change the validator set to ${n} validator${n === 1 ? "" : "s"}`;
  }
  if ("claim_rewards" in p) return `Claim validator rewards for ${short(p.claim_rewards.payout, 10, 6)}`;
  if ("deploy" in p) return "Deploy a contract";
  if ("call" in p) return `Call ${p.call.function} on ${short(p.call.contract, 10, 6)}`;
  return `Execute pending action ${p.execute_pending.id} of ${short(p.execute_pending.account, 10, 6)}`;
}

/** One-line description of a vault's waiting action. */
export function delayedAction(a: DelayedAction): string {
  if ("transfer" in a) {
    const t = a.transfer;
    return `Send ${amount(t.amount)}${assetLabel(t.asset)} to ${short(t.to, 10, 6)}`;
  }
  if ("set_auth" in a) return `Replace owner keys with ${policy(a.set_auth)}`;
  if ("call" in a) return `Call ${a.call.function} on ${short(a.call.contract, 10, 6)}`;
  return a.set_vault ? `Change vault: ${vault(a.set_vault)}` : "Stop being a vault";
}

export type Query =
  | { kind: "account"; address: string }
  | { kind: "tx"; id: string }
  | { kind: "block"; height: number }
  | { kind: "invalid" };

/** Interprets what someone typed in the search box. */
export function parseQuery(input: string): Query {
  const q = input.trim();
  if (/^qb1[02-9ac-hj-np-z]{20,}$/i.test(q)) return { kind: "account", address: q.toLowerCase() };
  if (/^[0-9a-f]{64}$/i.test(q)) return { kind: "tx", id: q.toLowerCase() };
  if (/^\d{1,15}$/.test(q.replace(/,/g, ""))) {
    return { kind: "block", height: Number(q.replace(/,/g, "")) };
  }
  return { kind: "invalid" };
}
