# `window.qubits`

How a website talks to the wallet. Only `https://qubits.sh` and its subdomains get it, on the default port and in the top frame. Chrome injects it there and nowhere else, and the wallet's background worker checks where each request really came from.

A site never gets a key or a signature. It can ask, and each request that moves anything opens the wallet's own window, where the user sees what the chain says the call would do.

```ts
if (!window.qubits) {
  // no wallet, or not on a qubits.sh address
}
const [address] = await window.qubits.connect();        // the user agrees once per site and account

const quote = await window.qubits.view({
  contract: AMM,
  function: "quote",
  args: ["native", QUSD, "1000000000000000000"],
});

const { id } = await window.qubits.call({               // opens the approval window
  contract: AMM,
  function: "swap",
  args: ["native", QUSD, "1000000000000000000", "950000", "deadline:600"],
  amount: "1000000000000000000",                        // 1 native token: it has 18 decimals
});

const { status, block_height, receipt } = await window.qubits.transaction(id);
```

The provider may arrive just after your script: listen for `qubits#initialized` on `window`.

| method | what it does | asks the user |
|---|---|---|
| `connect()` | gives `[address]` | once, per site and account |
| `accounts()` | gives `[address]`, or `[]` if not connected | no |
| `chain()` | gives `{ chain_id, genesis_hash, height }` | no |
| `view({ contract, function, args })` | reads a contract: `{ outcome, output, events }` | no |
| `call({ contract, function, args, amount })` | sends a call, gives `{ id }` once it is sent | every time |
| `transaction(id)` | gives `{ status, block_height, receipt }` | no |
| `request({ method, params })` | the same, as `qb_connect`, `qb_accounts`, `qb_chain`, `qb_view`, `qb_call`, `qb_transaction` | |

`{ id }` means the transaction left, not that it worked. It worked when `status` is `included` and `receipt.outcome` is `done`: a call that reverts is in a block too.

Arguments are strings, the way `qubits contract call` reads them: `qb1…` is an address, `native` the native token, `5` a `u128`, `u64:5` a `u64`, `deadline:600` that many seconds from now, `"text"` bytes with a length in front, and `0xabcd` raw bytes. `output` is hex, little-endian for numbers.

The wallet picks the gas from a simulation, so a site doesn't give any. A call the simulation says would fail can't be approved.

Errors have a `code`:

| code | meaning |
|---|---|
| 4001 | the user refused, or closed the window |
| 4100 | not connected: call `connect()` first |
| 4200 | no such method |
| 4300 | the call would fail: the message says why |
| 4900 | the wallet can't do it now: no account, no node, or another request from this page is waiting |
| -32602 | the request makes no sense |

To try a site on your own machine, it has to be a real subdomain over https: point a name like `dev.qubits.sh` at `127.0.0.1` in `/etc/hosts` and serve it with a certificate Chrome accepts, on port 443. `tests/site.mjs` does the same with a throwaway certificate.
