// Loads the real WebAssembly wallet core (built by `npm run wasm`) for tests.

import { readFileSync } from "node:fs";

import { type Core, coreFrom } from "../src/core";
import * as wasm from "../src/wasm/qubits_wasm.js";

let core: Core | undefined;

export function testCore(): Core {
  if (!core) {
    wasm.initSync({ module: readFileSync(new URL("../src/wasm/qubits_wasm_bg.wasm", import.meta.url)) });
    core = coreFrom(wasm);
  }
  return core;
}

export const PASSWORD = "a long enough password";
