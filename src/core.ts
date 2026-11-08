// Typed wrapper around the Rust wallet core (`qubits-wasm` in the chain's repository), which does all cryptography:
// key creation, key-file encryption, transaction building and signing.

import type { AuthPolicy, Payload, Role, SignedTransaction } from "./shared/api";
import init, * as wasm from "./wasm/qubits_wasm.js";

export type Scheme = "ml-dsa-65" | "slh-dsa-sha2-192s";

export interface KeyInfo {
  address: string;
  /** Scheme-tagged public key, hex. */
  public_key: string;
  scheme: Scheme;
}

export interface CreatedKey extends KeyInfo {
  /** Encrypted key file, the same format as `qubits key new` writes. */
  keystore: string;
}

export interface Signed {
  /** Hex of the encoded transaction, ready to submit. */
  transaction: string;
  id: string;
  fee: string;
}

export type Decoded = SignedTransaction & { id: string };

/** How long a signed transaction can still be included in a block. */
const VALID_FOR_MS = 60 * 60 * 1000;

export interface Core {
  createKey(scheme: Scheme, password: string): CreatedKey;
  keyInfo(keystore: string): KeyInfo;
  /** Throws `Error("wrong password")` if the password does not open the key file. */
  checkPassword(keystore: string, password: string): void;
  sign(
    status: unknown,
    account: unknown,
    keystore: string,
    password: string,
    role: Role,
    payload: Payload,
  ): Signed;
  decodeTransaction(hex: string): Decoded;
  /** Canonical form of a valid address; throws otherwise. */
  checkAddress(address: string): string;
  publicKeyInfo(taggedHex: string): KeyInfo;
  readonly minPasswordLength: number;
}

type Wasm = typeof wasm;

export function coreFrom(w: Wasm): Core {
  return {
    createKey: (scheme, password) => JSON.parse(w.createKey(scheme, password)) as CreatedKey,
    keyInfo: (keystore) => JSON.parse(w.keyInfo(keystore)) as KeyInfo,
    checkPassword: (keystore, password) => w.checkPassword(keystore, password),
    sign: (status, account, keystore, password, role, payload) =>
      JSON.parse(
        w.sign(
          JSON.stringify(status),
          JSON.stringify(account),
          keystore,
          password,
          role,
          JSON.stringify(payload),
          Date.now() + VALID_FOR_MS,
        ),
      ) as Signed,
    decodeTransaction: (hex) => JSON.parse(w.decodeTransaction(hex)) as Decoded,
    checkAddress: (address) => w.checkAddress(address),
    publicKeyInfo: (taggedHex) => JSON.parse(w.publicKeyInfo(taggedHex)) as KeyInfo,
    minPasswordLength: w.minPasswordLength(),
  };
}

/** Loads the WebAssembly module (fetches the .wasm file next to this script). */
export async function loadCore(): Promise<Core> {
  await init();
  return coreFrom(wasm);
}

export type { AuthPolicy };
