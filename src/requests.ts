// Requests from sites that wait for the user. They live in session storage, not in the worker's
// memory: Chrome stops the worker while a person reads, and content scripts can't read this store.

import type { ContractRequest } from "./sites";

const KEY = "site-requests";

export interface PendingRequest {
  id: string;
  origin: string;
  tabId: number;
  /** The page's own number for this request. */
  pageId: unknown;
  method: "qb_connect" | "qb_call";
  call?: ContractRequest;
  windowId?: number;
}

type Pending = Record<string, PendingRequest>;

export async function pendingRequests(): Promise<Pending> {
  return ((await chrome.storage.session.get(KEY))[KEY] as Pending | undefined) ?? {};
}

export async function keepRequest(request: PendingRequest): Promise<void> {
  await chrome.storage.session.set({ [KEY]: { ...(await pendingRequests()), [request.id]: request } });
}

export async function dropRequest(id: string): Promise<void> {
  const { [id]: _, ...rest } = await pendingRequests();
  await chrome.storage.session.set({ [KEY]: rest });
}

/** Answers the page that asked, once: a request that is gone can't be answered again. */
export async function answer(
  request: PendingRequest,
  reply: { result: unknown } | { error: { code: number; message: string } },
): Promise<void> {
  if (!(await pendingRequests())[request.id]) return;
  await dropRequest(request.id);
  await chrome.tabs
    .sendMessage(request.tabId, { channel: "qubits-wallet", id: request.pageId, ...reply })
    .catch(() => undefined); // the tab may have gone
}
