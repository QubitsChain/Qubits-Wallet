// JSON shapes of the node's HTTP API. Mirrors `qubits_types::rpc` in `chain/`.
// Amounts are decimal strings (they can exceed 2^53); keys and signatures are hex of their
// scheme-tagged bytes.

export type Hex = string;
export type Address = string;

export interface AuthPolicy {
  threshold: number;
  keys: Hex[];
}

export interface VaultPolicy {
  delay_ms: number;
  recovery: AuthPolicy | null;
}

export type Payload =
  | { transfer: { to: Address; asset: number; amount: string } }
  | { set_auth: { auth: AuthPolicy } }
  | { set_vault: { vault: VaultPolicy | null } }
  | { cancel_pending: { id: number } }
  | { execute_pending: { account: Address; id: number } }
  | { set_validators: { validators: { key: Hex; payout: Address }[] } }
  | { deploy: { code: Hex; args: Hex; gas_limit: number } }
  | { call: ContractCall }
  | { claim_rewards: { payout: Address } };

export interface ContractCall {
  contract: Address;
  function: string;
  args: Hex;
  amount: string;
  gas_limit: number;
}

export type DelayedAction =
  | { transfer: { to: Address; asset: number; amount: string } }
  | { set_auth: AuthPolicy }
  | { set_vault: VaultPolicy | null }
  | { call: ContractCall };

export interface PendingAction {
  id: number;
  unlock_at_ms: number;
  action: DelayedAction;
}

export type Role = "owner" | "recovery";

export interface Transaction {
  genesis_hash: Hex;
  sender: Address;
  nonce: number;
  fee: string;
  valid_until_ms: number;
  role: Role;
  payload: Payload;
}

export interface SignedTransaction {
  tx: Transaction;
  reveal: AuthPolicy | null;
  signatures: { index: number; signature: Hex }[];
}

/** A block as `/v1/blocks/{height}` returns it. */
export interface BlockResponse {
  hash: Hex;
  height: number;
  round: number;
  parent: Hex;
  /** index of the proposer in the epoch's validator set */
  proposer: number;
  timestamp_ms: number;
  tx_root: Hex;
  state_root: Hex;
  receipt_root: Hex;
  voters: number[];
  transaction_ids: Hex[];
  transactions: SignedTransaction[];
}

export interface StatusResponse {
  chain_id: string;
  genesis_hash: Hex;
  height: number;
  latest_hash: Hex;
  latest_timestamp_ms: number;
  state_root: Hex;
  min_fee_per_byte: number;
  mempool_size: number;
  state_from: number;
  blocks_from: number;
}

export interface AccountResponse {
  address: Address;
  exists: boolean;
  nonce: number;
  auth: AuthPolicy | null;
  vault: VaultPolicy | null;
  balances: { asset: number; amount: string }[];
  pending: PendingAction[];
}

export interface TransactionResponse {
  id: Hex;
  status: "pending" | "included";
  block_height: number | null;
  index: number | null;
  transaction: SignedTransaction;
  /** What a contract call did. Being in a block doesn't mean it worked. */
  receipt?: Receipt | null;
}

export type Outcome =
  | "done"
  | "out_of_gas"
  | "trapped"
  | "invalid"
  | { reverted: { reason: Hex } };

export interface Receipt {
  outcome: Outcome;
  gas_used: number;
  output: Hex;
  events: { contract: Address; topic: Hex; data: Hex }[];
  contract: Address | null;
}

export interface ViewResponse extends Receipt {
  /** The caller's native balance after the call, before any fee. */
  balance_after: string;
}

/** An error reply from the node, or a failure to reach it. */
export class ApiError extends Error {
  constructor(
    message: string,
    /** HTTP status, or 0 if the node could not be reached. */
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class Client {
  readonly base: string;

  constructor(
    base: string,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {
    this.base = base.replace(/\/+$/, "");
  }

  private async get<T>(path: string): Promise<T> {
    return this.request(path, { headers: { accept: "application/json" } });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.base}${path}`, init);
    } catch {
      throw new ApiError(`Can't reach the node at ${this.base}.`, 0);
    }
    const text = await response.text();
    if (!response.ok) {
      let message = text || response.statusText;
      try {
        message = (JSON.parse(text) as { error: string }).error;
      } catch {
        // Not JSON: keep the raw text.
      }
      throw new ApiError(message, response.status);
    }
    return JSON.parse(text) as T;
  }

  status(): Promise<StatusResponse> {
    return this.get("/v1/status");
  }

  account(address: Address): Promise<AccountResponse> {
    return this.get(`/v1/accounts/${encodeURIComponent(address)}`);
  }

  block(height: number): Promise<BlockResponse> {
    return this.get(`/v1/blocks/${height}`);
  }

  transaction(id: Hex): Promise<TransactionResponse> {
    return this.get(`/v1/transactions/${encodeURIComponent(id)}`);
  }

  /** Every deployed contract, oldest first. */
  async contracts(): Promise<Address[]> {
    return (await this.get<{ contracts: Address[] }>("/v1/contracts")).contracts;
  }

  /**
   * Runs a contract function against the latest state, for free. Nothing it does is kept. With a
   * caller it shows what that account's call would do, `amount` of the native token included.
   */
  view(
    contract: Address,
    fn: string,
    args: Hex = "",
    as: { caller: Address; amount: string } | null = null,
  ): Promise<ViewResponse> {
    return this.request(`/v1/contracts/${encodeURIComponent(contract)}/view`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ function: fn, args, ...as }),
    });
  }

  /** Submits a signed transaction (hex of its encoding). Returns its id. */
  async submit(transactionHex: Hex): Promise<Hex> {
    const reply = await this.request<{ id: Hex }>("/v1/transactions", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ transaction: transactionHex }),
    });
    return reply.id;
  }

  /** The newest `count` blocks, newest first. */
  async recentBlocks(latest: number, count: number): Promise<BlockResponse[]> {
    const heights: number[] = [];
    for (let h = latest; h >= 1 && heights.length < count; h--) heights.push(h);
    return Promise.all(heights.map((h) => this.block(h)));
  }
}

/**
 * Node to read from: `?rpc=` in the page URL, else the build-time `VITE_QUBITS_RPC`, else a
 * node on this machine.
 */
export function nodeUrl(location: Location, buildDefault?: string): string {
  const fromQuery = new URLSearchParams(location.search).get("rpc");
  if (fromQuery && /^https?:\/\//.test(fromQuery)) return fromQuery;
  return buildDefault || "http://127.0.0.1:8545";
}
