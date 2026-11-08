// The door between websites and the wallet. It holds no keys and signs nothing: it decides who
// may ask, answers what needs no one's agreement, and opens the approval window for the rest.

import { type PendingRequest, answer, keepRequest, pendingRequests, dropRequest } from "./requests";
import { Client } from "./shared/api";
import {
  NOT_CONNECTED,
  REFUSED,
  SiteError,
  type SiteRequest,
  UNAVAILABLE,
  allowedSite,
  parseRequest,
} from "./sites";
import type { Saved } from "./wallet";

const CHANNEL = "qubits-wallet";
const WINDOW = { width: 376, height: 660 };

async function savedWallet(): Promise<Saved> {
  const saved = (await chrome.storage.local.get("wallet")).wallet as Saved | undefined;
  if (!saved?.accounts?.length) throw new SiteError(UNAVAILABLE, "The wallet has no account yet.");
  return saved;
}

function activeAddress(saved: Saved): string {
  const account = saved.accounts[saved.active];
  if (!account) throw new SiteError(UNAVAILABLE, "The wallet has no account in use.");
  return account.info.address;
}

function connected(saved: Saved, origin: string): boolean {
  const address = activeAddress(saved);
  return (saved.sites ?? []).some((s) => s.origin === origin && s.address === address);
}

async function ask(pending: Omit<PendingRequest, "id">): Promise<{ waiting: true }> {
  const already = Object.values(await pendingRequests());
  if (already.some((r) => r.tabId === pending.tabId)) {
    throw new SiteError(UNAVAILABLE, "The wallet is already waiting for an answer from this page.");
  }
  const request: PendingRequest = { ...pending, id: crypto.randomUUID() };
  await keepRequest(request);
  const page = chrome.runtime.getManifest().action?.default_popup ?? "popup.html";
  const opened = await chrome.windows.create({
    ...WINDOW,
    type: "popup",
    focused: true,
    url: chrome.runtime.getURL(`${page}?request=${request.id}`),
  });
  if (opened?.id !== undefined) await keepRequest({ ...request, windowId: opened.id });
  return { waiting: true };
}

async function handle(request: SiteRequest, origin: string, tabId: number, pageId: unknown): Promise<unknown> {
  const saved = await savedWallet();
  const client = new Client(saved.nodeUrl);
  switch (request.method) {
    case "qb_accounts":
      return { result: connected(saved, origin) ? [activeAddress(saved)] : [] };
    case "qb_connect":
      if (connected(saved, origin)) return { result: [activeAddress(saved)] };
      return ask({ origin, tabId, pageId, method: request.method });
    case "qb_chain": {
      const { chain_id, genesis_hash, height } = await client.status();
      return { result: { chain_id, genesis_hash, height } };
    }
    case "qb_transaction": {
      const { status, block_height, receipt } = await client.transaction(request.id);
      return { result: { status, block_height, receipt: receipt ?? null } };
    }
    case "qb_view": {
      const { contract, function: name, args } = request.call;
      const { outcome, output, events } = await client.view(contract, name, args);
      return { result: { outcome, output, events } };
    }
    case "qb_call":
      if (!connected(saved, origin)) {
        throw new SiteError(NOT_CONNECTED, "Connect first: the account in use hasn't agreed to this site.");
      }
      return ask({ origin, tabId, pageId, method: request.method, call: request.call });
  }
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  // Chrome fills in `sender`, so unlike everything in `message` a page can't lie about it. Only
  // a site's top frame, in a tab, through our own content script, gets any further.
  const tabId = sender.tab?.id;
  const allowed =
    sender.id === chrome.runtime.id &&
    message?.channel === CHANNEL &&
    tabId !== undefined &&
    sender.frameId === 0 &&
    allowedSite(sender.origin);
  if (!allowed) return false;
  const origin = sender.origin as string;
  (async () => handle(parseRequest(message.request), origin, tabId, message.id))()
    .then(reply)
    .catch((e: unknown) => {
      const code = e instanceof SiteError ? e.code : UNAVAILABLE;
      reply({ error: { code, message: (e as Error).message } });
    });
  return true;
});

// Closing the window is an answer.
chrome.windows.onRemoved.addListener((windowId) => {
  void (async () => {
    for (const request of Object.values(await pendingRequests())) {
      if (request.windowId === windowId) {
        await answer(request, { error: { code: REFUSED, message: "The user closed the wallet." } });
      }
    }
  })();
});

// A page that is gone has nobody to answer, and nothing should be approved for it.
chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    for (const request of Object.values(await pendingRequests())) {
      if (request.tabId !== tabId) continue;
      await dropRequest(request.id);
      if (request.windowId !== undefined) await chrome.windows.remove(request.windowId).catch(() => undefined);
    }
  })();
});
