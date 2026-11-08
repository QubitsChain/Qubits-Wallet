# Qubits Wallet

The browser wallet for [Qubits](https://qubits.sh), a layer 1 secured by post-quantum signatures. It is a Chrome extension (Manifest V3).

> The Chrome Web Store listing is in review, and Qubits mainnet is not live yet. The [status page](https://qubits.sh/docs/status) says what exists and what doesn't.

## What it does

- Creates and imports keys: ML-DSA-65 by default, or SLH-DSA-SHA2-192s for a cold key.
- Keeps each key only as an encrypted key file (Argon2id and XChaCha20-Poly1305), the same format the `qubits` command line uses, so a key moves between the two either way.
- Sends the native coin and tokens. Before anything is signed it shows what will change: who receives, the fee, and the balance after.
- Lets websites on qubits.sh ask for an account and for transactions through `window.qubits`, each one approved in its own window. [PROVIDER.md](PROVIDER.md) is the guide.

## What it can reach

- One permission, `storage`, and no host permissions.
- Its scripts run on `https://qubits.sh` and its subdomains only, and the background worker checks every request against who Chrome says sent it.
- Keys never leave the browser. Signing happens in a WebAssembly core compiled from the chain's own Rust code, `qubits-wasm`.
- A password is kept in memory for 15 minutes after unlocking, and never on disk.

## Build

You need [Rust](https://rustup.rs), Node.js 20.19 or later, and `wasm-bindgen-cli` at exactly the version the core pins:

```sh
cargo install wasm-bindgen-cli --version 0.2.100
git clone --recurse-submodules https://github.com/QubitsChain/Qubits-Wallet
cd Qubits-Wallet
npm ci
npm run build
```

`chain/` is the [chain's repository](https://github.com/QubitsChain/Qubits-Chain) at the release the wallet is built with. Its `rust-toolchain.toml` pins the compiler and the WebAssembly target, so `rustup` installs them on the first build. `QUBITS_CHAIN` points the build at another copy.

Then open `chrome://extensions`, turn on Developer mode, choose "Load unpacked" and pick `dist/`.

A build looks for a node at `http://127.0.0.1:8545`. `VITE_QUBITS_RPC=https://your.node npm run build` picks another, and `npm run package` makes the store's zip in `release/`, for `https://mainnet.qubits.sh`. Source paths are remapped in the core, so a build carries no paths from the machine it was made on.

## Test

```sh
npm test
```

This runs the real WebAssembly core, the wallet's flow against a fake node, and, once `chain/target/debug/qubits` is built, a check that key files open in the command line too. `tests/live.test.ts` runs against a real node when `QUBITS_LIVE_RPC` and funded key files are given, and `tests/site.mjs` drives Chrome with the built extension through real websites and approvals.

## Layout

| Path | What it is |
|---|---|
| `src/wallet.ts` | Accounts, storage, the node client, and the sign, show, submit flow |
| `src/popup.ts`, `src/popup.css` | The screens |
| `src/core.ts` | The WebAssembly core: keys, encryption, signing |
| `src/background.ts`, `src/sites.ts`, `src/requests.ts` | Requests from websites: who may ask, what a call would really do |
| `src/provider.ts`, `src/bridge.ts` | `window.qubits` in the page, and the bridge to the wallet |
| `src/shared/` | The node's API types, a DOM builder that never uses `innerHTML`, formatting |

More is in the documentation: [the wallet](https://qubits.sh/docs/wallet) and [`window.qubits`](https://qubits.sh/docs/provider).

## License

Apache-2.0, see [`LICENSE`](LICENSE).
