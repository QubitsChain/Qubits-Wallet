// `window.qubits`, in the page's own world. It holds nothing and decides nothing: every request
// goes through `bridge.ts` to the wallet. No imports: this file is injected as it stands.

(() => {
  if ("qubits" in window) return;
  const CHANNEL = "qubits-wallet";

  interface Waiting {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }

  class QubitsError extends Error {
    constructor(
      readonly code: number,
      message: string,
    ) {
      super(message);
      this.name = "QubitsError";
    }
  }

  const waiting = new Map<number, Waiting>();
  let next = 1;

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (message?.channel !== CHANNEL || message.to !== "page") return;
    const pending = waiting.get(message.id);
    if (!pending) return;
    waiting.delete(message.id);
    if (message.error) pending.reject(new QubitsError(message.error.code, message.error.message));
    else pending.resolve(message.result);
  });

  const request = (body: { method: string; params?: unknown }): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = next++;
      waiting.set(id, { resolve, reject });
      window.postMessage({ channel: CHANNEL, to: "wallet", id, request: body }, location.origin);
    });

  const qubits = Object.freeze({
    isQubits: true,
    request,
    /** Asks to see the account in use. Gives its address, once the user agrees. */
    connect: () => request({ method: "qb_connect" }),
    /** The connected address, or an empty list. Never asks the user anything. */
    accounts: () => request({ method: "qb_accounts" }),
    chain: () => request({ method: "qb_chain" }),
    /** Reads from a contract, for free. */
    view: (params: unknown) => request({ method: "qb_view", params }),
    /** Asks the user to approve a contract call. Gives the transaction id once it is sent. */
    call: (params: unknown) => request({ method: "qb_call", params }),
    /** What became of a transaction. */
    transaction: (id: string) => request({ method: "qb_transaction", params: { id } }),
  });

  Object.defineProperty(window, "qubits", { value: qubits, enumerable: true });
  window.dispatchEvent(new Event("qubits#initialized"));
})();
