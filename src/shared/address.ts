// Addresses and their 32 bytes: bech32m with the prefix `qb`, as `Address` in qubits-types. Here
// and not in the WebAssembly core because the background worker needs it and has no core.

import type { Address, Hex } from "./api";

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const PREFIX = "qb";
const BECH32M = 0x2bc830a3;
const GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
  let check = 1;
  for (const value of values) {
    const top = check >>> 25;
    check = (((check & 0x1ffffff) << 5) ^ value) >>> 0;
    GENERATORS.forEach((generator, i) => {
      if ((top >>> i) & 1) check = (check ^ generator) >>> 0;
    });
  }
  return check;
}

function expanded(prefix: string): number[] {
  const codes = [...prefix].map((c) => c.charCodeAt(0));
  return [...codes.map((c) => c >> 5), 0, ...codes.map((c) => c & 31)];
}

function regroup(values: number[], from: number, to: number, pad: boolean): number[] | null {
  let bits = 0;
  let accumulator = 0;
  const out: number[] = [];
  const mask = (1 << to) - 1;
  for (const value of values) {
    accumulator = (accumulator << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((accumulator >> bits) & mask);
    }
    accumulator &= (1 << bits) - 1;
  }
  if (pad && bits > 0) out.push((accumulator << (to - bits)) & mask);
  if (!pad && (bits >= from || accumulator !== 0)) return null;
  return out;
}

/** The address's 32 bytes in hex, as a contract's arguments carry it. Throws if it isn't one. */
export function addressToHex(address: Address): Hex {
  const text = address.trim();
  const separator = text.lastIndexOf("1");
  if (text !== text.toLowerCase() || text.slice(0, separator) !== PREFIX) {
    throw new Error(`not a Qubits address: ${text}`);
  }
  const data = [...text.slice(separator + 1)].map((c) => CHARSET.indexOf(c));
  if (data.includes(-1) || data.length < 6) throw new Error(`not a Qubits address: ${text}`);
  if (polymod([...expanded(PREFIX), ...data]) !== BECH32M) {
    throw new Error(`a character is off in ${text}`);
  }
  const bytes = regroup(data.slice(0, -6), 5, 8, false);
  if (bytes?.length !== 32) throw new Error(`not a Qubits address: ${text}`);
  return bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The address of 32 bytes in hex. */
export function addressFromHex(hex: Hex): Address {
  const bytes = (hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16));
  if (bytes.length !== 32 || bytes.some(Number.isNaN)) throw new Error("an address is 32 bytes");
  const data = regroup(bytes, 8, 5, true) ?? [];
  const check = polymod([...expanded(PREFIX), ...data, 0, 0, 0, 0, 0, 0]) ^ BECH32M;
  const checksum = [0, 1, 2, 3, 4, 5].map((i) => (check >>> (5 * (5 - i))) & 31);
  return `${PREFIX}1${[...data, ...checksum].map((d) => CHARSET[d]).join("")}`;
}
