// Carries messages between the page and the wallet, in the content script's isolated world, the
// only place that can do both. It trusts nothing it carries: the background worker judges every
// request by who Chrome says sent it. No imports: this file is injected as it stands.

(() => {
  const CHANNEL = "qubits-wallet";

  const toPage = (id: unknown, reply: { result?: unknown; error?: unknown }) =>
    window.postMessage({ channel: CHANNEL, to: "page", id, ...reply }, location.origin);

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (message?.channel !== CHANNEL || message.to !== "wallet") return;
    chrome.runtime
      .sendMessage({ channel: CHANNEL, id: message.id, request: message.request })
      .then((reply) => {
        // a request the user has to answer comes back later, from the approval window
        if (!reply?.waiting) toPage(message.id, reply ?? { error: { code: 4900, message: "no answer" } });
      })
      .catch(() => toPage(message.id, { error: { code: 4900, message: "The wallet is not available." } }));
  });

  chrome.runtime.onMessage.addListener((message: { channel?: string; id?: unknown }, sender) => {
    if (sender.id !== chrome.runtime.id || message?.channel !== CHANNEL) return;
    toPage(message.id, message as { result?: unknown; error?: unknown });
  });
})();
