#!/bin/sh
# Builds the wallet core, `qubits-wasm`, from the chain's source into src/wasm/. The source is
# QUBITS_CHAIN if set, else the chain/ submodule, else a chain/ next to this folder.
set -e
cd "$(dirname "$0")/.."
if [ -n "$QUBITS_CHAIN" ]; then
    chain=$QUBITS_CHAIN
elif [ -f chain/Cargo.toml ]; then
    chain=chain
else
    chain=../chain
fi
# Panic messages carry source paths; these make them the same on every machine, and name no one.
chain_dir=$(cd "$chain" && pwd)
export RUSTFLAGS="--remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo --remap-path-prefix=$chain_dir=/chain"
cargo build --manifest-path "$chain/Cargo.toml" -p qubits-wasm --target wasm32-unknown-unknown --release
wasm-bindgen --target web --out-dir src/wasm "$chain/target/wasm32-unknown-unknown/release/qubits_wasm.wasm"
