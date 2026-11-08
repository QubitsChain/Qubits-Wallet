import "./popup.css";

import type { AccountResponse, Address, Payload, StatusResponse, ViewResponse } from "./shared/api";
import { ApiError } from "./shared/api";
import { h, mono } from "./shared/dom";
import * as f from "./shared/format";
import { type Core, loadCore, type Scheme } from "./core";
import { answer, type PendingRequest, pendingRequests } from "./requests";
import {
  NOT_CONNECTED,
  REFUSED,
  UNAVAILABLE,
  WOULD_FAIL,
  changesOf,
  gasFor,
  isUnlimited,
} from "./sites";
import {
  type Account,
  type Activity,
  chromeSessionStore,
  chromeStore,
  localStore,
  pageSessionStore,
  type Saved,
  type Transfer,
  Wallet,
  WalletError,
  type ContractCall,
  type Held,
  type Token,
  type TokenSend,
  MAX_TX_GAS,
  failureOf,
  type Site,
} from "./wallet";

const app = document.getElementById("app") as HTMLElement;
const statusLine = document.getElementById("status") as HTMLElement;
const chainLine = document.getElementById("chain") as HTMLElement;
const who = document.getElementById("who") as HTMLButtonElement;
const logOutButton = document.getElementById("out") as HTMLButtonElement;
const stage = document.getElementById("stage") as HTMLElement;
const theDrop = h("div", { class: "drop", "aria-hidden": "true" });
stage.append(theDrop);

const STATUS = "mt-0 min-h-[1.5em] border-t border-rule pt-2.5 pb-4 font-mono text-[0.72rem]";
const LABEL = "font-display text-[0.72rem] text-soft";
/** the one filled pill on a screen without a form */
const PRIMARY = "primary";
const QUIET = "quiet";
const DANGER = "danger";
const TINY = "px-3 py-1 text-[0.78rem]";
const WORDS = "mt-6 flex flex-wrap items-center gap-2";
const HINT = "my-0 min-h-[1.2em] text-[0.75rem] leading-snug";
/** Where a transaction id leads: the explorer's page for it. */
const EXPLORER = "https://qubits.sh/explorer";
/** a line of a list: the rule under it is on the wrapper, so a control can sit at its end */
const ROW = "bare grid w-full min-w-0 flex-1 grid-cols-[minmax(0,1fr)] gap-0.5 py-2.5 text-[0.9rem] leading-snug text-bone";
/** after this long without a block, the header says so */
const IDLE_AFTER_MS = 10 * 60_000;
/** locks the wallet when the unlock lapses while the popup is open */
let lockTimer: ReturnType<typeof setTimeout> | undefined;

/** How long a message that needs no answer stays. */
const SAY_FOR_MS = 3_000;
let sayTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * The wallet's voice, on the bottom line. What went well goes away by itself; an error stays until
 * the next thing happens, and so does `wait`, for something still under way.
 */
function say(message: string, kind: "info" | "error" | "done" | "wait" = "info"): void {
  clearTimeout(sayTimer);
  statusLine.textContent = message;
  statusLine.className = `${STATUS} ${{ info: "text-soft", wait: "text-soft", error: "text-serial", done: "text-ready" }[kind]}`;
  if (message && (kind === "info" || kind === "done")) sayTimer = setTimeout(() => say(""), SAY_FOR_MS);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Lets the browser paint before a long synchronous step (key derivation, signing). */
const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 30));

async function busy(button: HTMLButtonElement, label: string, work: () => Promise<void>): Promise<void> {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    await nextFrame();
    await work();
  } catch (error) {
    say(messageOf(error), "error");
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function field(label: string, input: HTMLElement, hint?: HTMLElement | string): HTMLElement {
  return h(
    "label",
    { class: "grid gap-1.5" },
    h("span", { class: LABEL }, label),
    input,
    typeof hint === "string" ? h("small", { class: "text-[0.75rem] leading-snug text-soft" }, hint) : (hint ?? null),
  );
}

function passwordInput(): HTMLInputElement {
  return h("input", { type: "password", name: "password", autocomplete: "current-password", required: "" });
}

/** A control: a pill. */
function word(text: string, onClick: () => void, cls = ""): HTMLButtonElement {
  const button = h("button", { type: "button", class: cls }, text);
  button.addEventListener("click", onClick);
  return button;
}

/** A control that leaves the popup: a pill that is a link, opened in a new tab. */
function out(text: string, href: string, cls = ""): HTMLAnchorElement {
  return h("a", { href, target: "_blank", rel: "noopener", class: `pill ${cls}` }, text);
}

function explorerUrl(id: string): string {
  return `${EXPLORER}/id/${encodeURIComponent(id)}`;
}

function title(text: string, lead?: string): HTMLElement[] {
  const parts: HTMLElement[] = [h("h1", null, text)];
  if (lead) parts.push(h("p", { class: "mt-0 text-soft" }, lead));
  return parts;
}

/** The one mark: beside the thing it concerns. */
function dot(cls = ""): HTMLElement {
  return h("span", { class: `inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-serial ${cls}`, "aria-hidden": "true" });
}

function marked(text: string, more?: string): HTMLElement {
  return h(
    "p",
    { class: "my-3 flex items-start gap-2.5 text-[0.8rem] leading-snug" },
    dot("mt-[0.5em]"),
    h("span", null, text, more ? h("span", { class: "text-soft" }, ` ${more}`) : null),
  );
}

type Row = [string, string | HTMLElement, boolean?];

/** Facts as a ledger of pairs: label over value, a rule under each, a mark where it matters. */
function ledger(rows: Row[], cls = "mt-5"): HTMLElement {
  return h(
    "dl",
    { class: `${cls} grid gap-2` },
    rows.map(([label, value, mark]) =>
      h(
        "div",
        { class: "flex items-end justify-between gap-3 border-b border-rule pb-1.5" },
        h(
          "div",
          { class: "min-w-0" },
          h("dt", { class: `${LABEL} leading-tight` }, label),
          h("dd", { class: "m-0 mt-0.5 font-mono text-[0.78rem] leading-snug break-all" }, value),
        ),
        mark ? dot("mb-1.5") : null,
      ),
    ),
  );
}

interface RowSpec {
  main: string | HTMLElement;
  sub?: string | HTMLElement;
  subCls?: string;
  right?: string | HTMLElement;
  onClick?: () => void;
  trailing?: HTMLElement;
}

/** A line of a list: what it is, what became of it, something small on the right. */
function row(spec: RowSpec): HTMLElement {
  const top = h(
    "span",
    { class: "flex items-baseline justify-between gap-3" },
    h("span", { class: "min-w-0 truncate" }, spec.main),
    spec.right ? h("span", { class: "shrink-0 font-mono text-[0.72rem] text-soft" }, spec.right) : null,
  );
  const under = spec.sub ? h("span", { class: `block truncate text-[0.75rem] ${spec.subCls ?? "text-soft"}` }, spec.sub) : null;
  let body: HTMLElement;
  if (spec.onClick) {
    body = h("button", { type: "button", class: ROW, "data-row": "" }, top, under);
    body.addEventListener("click", spec.onClick);
  } else {
    body = h("div", { class: ROW }, top, under);
  }
  return h("div", { class: "flex items-center gap-4 border-b border-rule" }, body, spec.trailing ?? null);
}

/** Moves the drop to where a screen wants it: `x`, `y` of its centre and `r`, in popup pixels. */
function drop(x: number, y: number, r: number, dim = false): null {
  theDrop.classList.toggle("bg-ink-dim", dim);
  theDrop.style.left = `${x - r}px`;
  theDrop.style.top = `${y - r}px`;
  theDrop.style.width = `${2 * r}px`;
  theDrop.style.height = `${2 * r}px`;
  return null;
}

function download(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = h("a", { href: url, download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function show(...parts: (HTMLElement | null)[]): void {
  app.replaceChildren(...parts.filter((part): part is HTMLElement => part !== null));
  app.scrollTop = 0;
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dayName(ms: number, now: number): string {
  const days = Math.round((startOfDay(ms) - startOfDay(now)) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function timeOf(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function clock(ms: number, now = Date.now()): string {
  return `${dayName(ms, now)} ${timeOf(ms)}`;
}

function delayText(ms: number): string {
  const hours = ms / 3_600_000;
  return hours >= 1 ? `${Number(hours.toFixed(1))} h` : `${Math.round(ms / 60_000)} min`;
}

/** "2 hours", not "2 hours 5 minutes". */
function roughly(ms: number): string {
  return f.duration(ms).split(" ").slice(0, 2).join(" ");
}

function showSetup(wallet: Wallet, core: Core, saved: Saved | null = null): void {
  chainLine.textContent = saved ? "another key" : "a wallet for the Qubits chain";
  who.hidden = saved === null;
  logOutButton.hidden = saved === null;
  const name = h("input", { type: "text", autocomplete: "off", placeholder: `Account ${(saved?.accounts.length ?? 0) + 1}` });
  const scheme = h(
    "select",
    { name: "scheme" },
    h("option", { value: "ml-dsa-65" }, "ML-DSA-65, the everyday key: fast to sign"),
    h("option", { value: "slh-dsa-sha2-192s" }, "SLH-DSA, the cold key: hash-based, slow to sign"),
  );
  const password = h("input", { type: "password", autocomplete: "new-password", required: "" });
  const repeat = h("input", { type: "password", autocomplete: "new-password", required: "" });
  const create = h("button", { type: "submit" }, "Create key");
  const createForm = h(
    "form",
    null,
    saved ? field("Name", name, "Only for this wallet's list; nothing on the chain sees it.") : null,
    field("Key type", scheme),
    field("Password", password, `At least ${core.minPasswordLength} characters. It encrypts the key on this computer.`),
    field("Repeat the password", repeat),
    h("div", { class: "mt-1 flex flex-wrap items-center gap-2.5" }, create, saved ? word("Back", () => void open(wallet, core, saved, "accounts"), QUIET) : null),
  );
  createForm.addEventListener("submit", (e) => {
    e.preventDefault();
    void busy(create, "Creating the key…", async () => {
      const created = await wallet.create(scheme.value as Scheme, password.value, repeat.value, name.value);
      showBackup(wallet, core, created.keystore, created.address);
    });
  });

  const file = h("input", { type: "file", accept: ".json,application/json", class: "hidden" });
  file.addEventListener("change", async () => {
    const chosen = file.files?.[0];
    if (!chosen) return;
    try {
      await wallet.importKeyFile(await chosen.text(), name.value);
      await start(wallet, core);
      say("Key imported.", "done");
    } catch (error) {
      say(messageOf(error), "error");
    }
  });

  show(
    drop(80, 60, 150),
    h(
      "div",
      { class: saved ? "mt-28" : "mt-44" },
      ...(saved
        ? title("Another key", "A second account in this wallet, with its own address and password.")
        : title("A key of your own", "It stays in this browser, encrypted with your password. Qubits never sees it.")),
    ),
    createForm,
    h(
      "p",
      { class: "mt-8 flex items-center gap-3" },
      h("span", { class: "text-[0.8rem] text-soft" }, "or"),
      word("Import a key file", () => file.click(), QUIET),
      file,
    ),
  );
}

function showBackup(wallet: Wallet, core: Core, keystore: string, address: string): void {
  show(
    drop(180, 150, 110),
    h("p", { class: "mt-24 text-center font-display text-[1.9rem] text-bone" }, address.slice(0, 7)),
    h(
      "div",
      { class: "mt-16" },
      ...title(
        "Back up your key",
        "If this browser is reset, the key file and your password are the only way back to your coins. Save the file somewhere outside this computer.",
      ),
    ),
    h("p", { class: "mt-5 mb-0 text-[0.8rem] text-soft" }, "Your address"),
    mono(address),
    h(
      "div",
      { class: WORDS },
      word("Download the key file", () => download(`qubits-key-${address.slice(3, 11)}.json`, keystore), PRIMARY),
      word("I saved it, continue", () => void start(wallet, core), QUIET),
    ),
  );
}

type View = "home" | "send" | "receive" | "settings" | "activity" | "accounts" | "tokens" | "sites";

interface Screen {
  wallet: Wallet;
  core: Core;
  saved: Saved;
  /** the account in use */
  me: Account;
  status: StatusResponse;
  account: AccountResponse;
  /** the tokens this wallet shows on this chain, and what the account holds of them */
  held: Held[];
}

function balanceOf(account: AccountResponse): string {
  return f.brief(account.balances.find((b) => b.asset === 0)?.amount ?? "0");
}

/** The balance at the size that fits 320 px: Poiret One digits are wide. */
function bigBalance(text: string): HTMLElement {
  const size = text.length > 12 ? "text-[2.1rem]" : text.length > 9 ? "text-[2.4rem]" : "text-[2.6rem]";
  return h("p", { class: `my-1 font-display ${size} leading-none` }, text);
}

/** Who an address is to this wallet, if anyone. */
function nameOf(sc: Screen, address: Address): { name: string; kind: "self" | "account" } | null {
  if (address === sc.me.info.address) return { name: "yourself", kind: "self" };
  const own = sc.saved.accounts.find((a) => a.info.address === address);
  return own ? { name: own.name, kind: "account" } : null;
}

function headline(p: Payload): string {
  if ("transfer" in p) return `Send ${f.amount(p.transfer.amount)}`;
  if ("set_vault" in p) {
    return p.set_vault.vault ? `Make it a vault, ${delayText(p.set_vault.vault.delay_ms)}` : "Stop being a vault";
  }
  if ("cancel_pending" in p) return `Cancel waiting action ${p.cancel_pending.id}`;
  if ("execute_pending" in p) return `Execute waiting action ${p.execute_pending.id}`;
  if ("set_auth" in p) return "Replace the owner keys";
  if ("call" in p) return `Call ${p.call.function}`;
  if ("deploy" in p) return "Deploy a contract";
  return "Change the validators";
}

/** One line for a list: "Send 250 to Main". */
function balanceIn(account: AccountResponse): bigint {
  return BigInt(account.balances.find((b) => b.asset === 0)?.amount ?? "0");
}

function nameOrShort(sc: Screen, address: Address): string {
  return nameOf(sc, address)?.name ?? f.short(address, 8, 5);
}

function describe(sc: Screen, a: Activity): string {
  const p = a.payload;
  if (a.token) return `Send ${tokenAmount(a.token.amount, a.token)} to ${nameOrShort(sc, a.token.to)}`;
  if ("transfer" in p) return `${headline(p)} to ${nameOrShort(sc, p.transfer.to)}`;
  if ("set_vault" in p || "cancel_pending" in p || "execute_pending" in p) return headline(p);
  return f.payload(p);
}

function tokenAmount(units: string, token: { symbol: string; decimals: number }): string {
  return `${f.amount(units, token.decimals)} ${token.symbol}`;
}

/** "Main qb1abc…xyz" for one of the accounts here, the address alone for anyone else. */
function whoIs(sc: Screen, address: Address): string | HTMLElement {
  const known = nameOf(sc, address);
  if (!known) return f.short(address, 26, 8);
  return h("span", null, known.name, h("span", { class: "ml-2 text-soft" }, f.short(address, 12, 6)));
}

function outcome(a: Activity): { text: string; cls: string } {
  if (a.status === "included") return { text: `in block ${f.integer(a.height ?? 0)}`, cls: "text-soft" };
  if (a.status === "failed") return { text: `failed: ${a.note ?? "rejected by the node"}`, cls: "text-serial" };
  return { text: "waiting for a block", cls: "text-tint" };
}

/** Forgets every kept password. The keys stay, encrypted; the next visit asks for the password. */
async function logOut(wallet: Wallet, core: Core, saved: Saved): Promise<void> {
  await wallet.lock();
  showUnlock(wallet, core, saved);
  say("");
}

async function screenOf(wallet: Wallet, core: Core, saved: Saved): Promise<Screen | null> {
  let status: StatusResponse;
  let account: AccountResponse;
  try {
    ({ status, account } = await wallet.overview(saved));
  } catch (error) {
    showUnreachable(wallet, core, saved, messageOf(error));
    return null;
  }
  const settled = await wallet.settle(saved);
  const current = await wallet.discoverTokens(settled, status.genesis_hash);
  const held = await wallet.holdings(current, status.genesis_hash);
  const sc: Screen = { wallet, core, saved: current, me: wallet.account(current), status, account, held };
  const idle = Date.now() - status.latest_timestamp_ms;
  chainLine.textContent =
    `${status.chain_id}, block ${f.integer(status.height)}` + (idle > IDLE_AFTER_MS ? `, idle ${roughly(idle)}` : "");
  who.textContent = sc.me.name;
  who.hidden = false;
  who.onclick = () => showAccounts(sc);
  logOutButton.hidden = asking !== null;
  logOutButton.onclick = () => void logOut(wallet, core, current);
  return sc;
}

/** Locks when the unlock lapses, even with the popup open. */
function armLock(wallet: Wallet, core: Core, saved: Saved, until: number): void {
  clearTimeout(lockTimer);
  lockTimer = setTimeout(
    () => {
      void wallet.lock().then(() => showUnlock(wallet, core, saved));
    },
    Math.max(0, until - Date.now()),
  );
}

async function open(wallet: Wallet, core: Core, saved: Saved, view: View): Promise<void> {
  const session = await wallet.unlocked(saved);
  if (!session) {
    showUnlock(wallet, core, saved, () => open(wallet, core, saved, view));
    return;
  }
  armLock(wallet, core, saved, session.until);
  const sc = await screenOf(wallet, core, saved);
  if (!sc) return;
  if (view === "home") showHome(sc);
  else if (view === "send") showSend(sc);
  else if (view === "receive") showReceive(sc);
  else if (view === "settings") showSettings(sc);
  else if (view === "activity") showActivity(sc);
  else if (view === "tokens") showTokens(sc);
  else if (view === "sites") showSites(sc);
  else showAccounts(sc);
}

function back(sc: Screen, view: View = "home"): HTMLButtonElement {
  return word(view === "home" ? "Back" : "Home", () => void open(sc.wallet, sc.core, sc.saved, view), QUIET);
}

function activityRow(sc: Screen, a: Activity, right: string): HTMLElement {
  const { text, cls } = outcome(a);
  return row({
    main: describe(sc, a),
    sub: text,
    subCls: cls,
    right,
    onClick: () => showActivityDetail(sc, a),
  });
}

function showHome(sc: Screen): void {
  const { account, me, wallet, saved } = sc;
  const recent = wallet.activity(saved).slice(0, 3);
  const now = Date.now();
  const nav = [
    word("Send", () => showSend(sc), PRIMARY),
    word("Receive", () => showReceive(sc)),
    word("Tokens", () => showTokens(sc)),
    recent.length ? word("Activity", () => showActivity(sc)) : null,
    word("Settings", () => showSettings(sc), QUIET),
  ];
  const standing = account.exists ? "Transfers leave with the next block" : "Nothing here yet";
  show(
    drop(250, 160, 180),
    h(
      "div",
      { class: "mt-12 flex h-[200px] flex-col items-center justify-center text-center" },
      bigBalance(balanceOf(account)),
      h("p", { class: "my-0 font-mono text-[0.68rem] text-tint" }, f.short(me.info.address, 22, 8)),
    ),
    h(
      "div",
      { class: "mt-8" },
      h("p", { class: "my-0 font-display text-[1.05rem]" }, standing),
      !account.exists ? h("p", { class: "my-0.5 text-[0.85rem] text-soft" }, "Share your address to receive the first coins.") : null,
    ),
    h("div", { class: WORDS }, ...nav),
    sc.held.length ? h("div", { class: "mt-6" }, ...sc.held.slice(0, 3).map((held) => tokenRow(sc, held))) : null,
    recent.length ? h("div", { class: "mt-5" }, ...recent.map((a) => activityRow(sc, a, dayName(a.at, now)))) : null,
  );
}

/** A line for a token: its balance, and a tap to send it. */
function tokenRow(sc: Screen, held: Held, sub?: string, trailing?: HTMLElement): HTMLElement {
  const { token, balance } = held;
  return row({
    main: token.symbol,
    right: h("span", { class: "text-[0.8rem] text-bone" }, balance === null ? "?" : f.brief(balance, token.decimals)),
    sub,
    onClick: () => showSend(sc, { token }),
    trailing,
  });
}

function showTokens(sc: Screen): void {
  const { wallet, core, saved } = sc;
  const contract = h("input", { type: "text", spellcheck: "false", required: "", placeholder: "qb1…", autocomplete: "off" });
  const add = h("button", { type: "submit", class: QUIET }, "Add token");
  const form = h(
    "form",
    null,
    field("Another token, by its address", contract),
    h("div", { class: "flex flex-wrap items-center gap-2.5" }, add, back(sc)),
  );
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void busy(add, "Looking…", async () => {
      const updated = await wallet.addToken(saved, contract.value);
      say(`Added ${updated.tokens.at(-1)?.symbol}.`, "done");
      await open(wallet, core, updated, "tokens");
    });
  });
  const rows = sc.held.map((held) => {
    const hide = word(
      "Hide",
      async () => {
        const updated = await wallet.removeToken(saved, held.token);
        say(`${held.token.symbol} is hidden. It is still yours.`);
        await open(wallet, core, updated, "tokens");
      },
      `${QUIET} ${TINY}`,
    );
    return tokenRow(sc, held, held.token.name, hide);
  });
  show(
    drop(300, 100, 120),
    h("div", { class: "mt-8" }, ...title("Tokens", rows.length ? "Tap one to send it." : "Tokens you hold show up here.")),
    rows.length ? h("div", { class: "mt-3" }, ...rows) : null,
    form,
  );
}

/** What the transfer will do, from the node's view of the account, for the user to check. Nothing
 *  is signed until "Send it". */
interface Typed {
  to: string;
  amount: string;
  token?: Token;
}

/** A send, ready to review: what goes where, in base units of the coin or of `sent`'s token. */
interface Draft {
  payload: Transfer | ContractCall;
  to: Address;
  amount: string;
  sent: TokenSend | null;
  typed: Typed;
}

function showReview(sc: Screen, draft: Draft): void {
  const { wallet, core, account, saved, status } = sc;
  const { payload, to, amount, sent, typed } = draft;
  const fee = sent ? wallet.tokenFeeEstimate(saved, status, account) : wallet.feeEstimate(saved, status, account);
  const coins = BigInt(account.balances.find((b) => b.asset === 0)?.amount ?? "0");
  const coinsAfter = coins - fee - (sent ? 0n : BigInt(amount));
  const shown = sent ? tokenAmount(amount, sent) : f.amount(amount);
  const isNew = nameOf(sc, to) === null && wallet.lastSentTo(saved, to) === null;
  const lacking = coinsAfter < 0n;
  const rows: Row[] = [
    ["to", whoIs(sc, to)],
    ["you send", shown],
    [sent ? "fee at most, the rest comes back" : "fee, about", f.brief(fee.toString())],
  ];
  if (sent) {
    const held = sc.held.find((x) => x.token.contract === typed.token?.contract);
    const left = BigInt(held?.balance ?? "0") - BigInt(amount);
    rows.push([`${sent.symbol} after`, f.brief(left.toString(), sent.decimals)]);
  }
  // a token's fee is paid in coins: worth a line only when there aren't enough
  if (!sent || lacking) {
    rows.push([
      "balance after, about",
      lacking ? "not enough coins" : f.brief(coinsAfter.toString()),
      lacking,
    ]);
  }
  rows.push(["leaves", account.vault ? `after the vault's ${delayText(account.vault.delay_ms)}` : "with the next block"]);
  const submit = word(
    "Send it",
    () =>
      void busy(submit, "Sending…", async () => {
        const session = await wallet.unlocked(saved);
        if (!session) {
          // The unlock lapsed while reading: ask, then come back here.
          showUnlock(wallet, core, saved, async () => {
            const fresh = await screenOf(wallet, core, saved);
            if (fresh) showReview(fresh, draft);
          });
          return;
        }
        const prepared = await wallet.prepare(saved, session.password, "owner", payload);
        let current = saved;
        let id: string;
        try {
          id = await wallet.submit(current, prepared);
        } catch (error) {
          if (error instanceof ApiError && error.status > 0) {
            current = await wallet.record(current, prepared, Date.now(), sent ? { token: sent } : {});
            current = await wallet.setActivity(current, prepared.signed.id, "failed", { note: error.message });
            sc.saved = current;
          }
          throw error;
        }
        current = await wallet.record(current, prepared, Date.now(), sent ? { token: sent } : {});
        sc.saved = current;
        say(`Sent as ${f.short(id)}. Waiting for a block…`, "wait");
        try {
          const { height, failed } = await wallet.waitIncluded(current, id);
          current = await wallet.settle(current);
          if (failed) say(`It did not go through: ${failed}. The fee was still paid.`, "error");
          else say(`Done: in block ${f.integer(height)}.`, "done");
        } catch {
          say("Sent, but no block has included it yet. Activity will show when one does.");
        }
        await open(wallet, core, current, "home");
      }),
    PRIMARY,
  );
  show(
    drop(60, 330, 120, true),
    h("p", { class: "mt-6 mb-0 text-[0.8rem] text-tint" }, "Check it. It is signed and sent when you say so."),
    h("p", { class: `${LABEL} mt-4 mb-0` }, "you are about to"),
    h("p", { class: "my-0 font-display text-[1.9rem] leading-tight" }, sent ? `Send ${shown}` : headline(payload)),
    ledger(rows, "mt-3"),
    isNew ? marked("A new address: nothing has gone there from this wallet before.", "Check every character; it cannot be undone.") : null,
    h("div", { class: WORDS }, submit, word("Back", () => showSend(sc, typed), QUIET)),
  );
  say("");
}

function showSend(sc: Screen, prefill: Partial<Typed> = {}): void {
  const { account, wallet, saved, status } = sc;
  const now = Date.now();
  const coinFee = wallet.feeEstimate(saved, status, account);
  const tokenFee = wallet.tokenFeeEstimate(saved, status, account);
  const balance = BigInt(account.balances.find((b) => b.asset === 0)?.amount ?? "0");
  chainLine.textContent = `${balanceOf(account)} available`;
  if (balance === 0n) {
    const lead = sc.held.length
      ? "A token needs a little of the chain's coin for the fee. Share your address to receive some."
      : "Nothing to send yet. Share your address to receive the first coins.";
    show(
      drop(330, 520, 150),
      h("div", { class: "mt-8" }, ...title("Send", lead)),
      h("div", { class: WORDS }, word("Receive", () => showReceive(sc), PRIMARY), back(sc)),
    );
    return;
  }
  const to = h("input", { type: "text", spellcheck: "false", required: "", placeholder: "qb1…", autocomplete: "off" });
  const amount = h("input", { type: "text", inputmode: "decimal", required: "", placeholder: "0", autocomplete: "off", class: "pr-16" });
  to.value = prefill.to ?? "";
  amount.value = prefill.amount ?? "";
  const asset = h(
    "select",
    null,
    h("option", { value: "" }, "Qubits"),
    ...sc.held.map(({ token }) => h("option", { value: token.contract }, token.symbol)),
  );
  asset.value = prefill.token?.contract ?? "";
  const chosen = (): Held | null => sc.held.find((x) => x.token.contract === asset.value) ?? null;
  const toHint = h("p", { class: HINT });
  const amountHint = h("p", { class: HINT });

  // Says who the address is before anything is signed; the one mark is for a stranger.
  const checkTo = () => {
    const text = to.value.trim();
    toHint.replaceChildren();
    toHint.className = `${HINT} text-soft`;
    if (!text) return;
    const checked = wallet.checkAddress(text);
    if ("error" in checked) {
      toHint.className = `${HINT} text-serial`;
      toHint.textContent = /checksum/.test(checked.error)
        ? "Not quite a Qubits address: a character is off."
        : "Not a Qubits address. They start with qb1.";
      return;
    }
    const known = nameOf(sc, checked.address);
    const before = wallet.lastSentTo(saved, checked.address);
    if (known) {
      toHint.textContent = known.kind === "self" ? "Your own address." : `${known.name}, one of your accounts.`;
    } else if (before !== null) {
      toHint.textContent = `Sent there before, ${dayName(before, now)}.`;
    } else {
      toHint.className = `${HINT} flex items-center gap-2 text-bone`;
      toHint.append(dot(), "A new address: nothing has gone there from this wallet before.");
    }
  };
  // The fee and what stays, as the amount is typed.
  const checkAmount = () => {
    const held = chosen();
    const decimals = held?.token.decimals ?? f.DECIMALS;
    const has = BigInt(held ? (held.balance ?? "0") : balance);
    const fee = held ? tokenFee : coinFee;
    const feeText = `Fee ${held ? "at most" : "about"} ${f.brief(fee.toString())}.`;
    const of = (units: bigint) =>
      held ? `${f.brief(units.toString(), held.token.decimals)} ${held.token.symbol}` : f.brief(units.toString());
    chainLine.textContent = `${of(has)} available`;
    amountHint.className = `${HINT} text-soft`;
    const text = amount.value.trim();
    const refuse = (message: string) => {
      amountHint.className = `${HINT} text-serial`;
      amountHint.textContent = message;
    };
    const kept = wallet.recoveryReserve(status, account);
    if (held && balance < fee + kept) {
      refuse(
        kept > 0n
          ? `Not enough coins for the fee: a vault keeps ${f.brief(kept.toString())} for its recovery.`
          : `Not enough coins for the fee: at most ${f.brief(fee.toString())}.`,
      );
      return;
    }
    if (!text) {
      amountHint.textContent = feeText;
      return;
    }
    const units = f.baseUnits(text, decimals);
    if (units === null) {
      refuse(`A positive amount, with at most ${decimals} decimals.`);
      return;
    }
    const after = has - BigInt(units) - (held ? 0n : fee);
    if (after < 0n) {
      refuse(held ? `More than you have: ${of(has)}.` : `More than you have: ${of(has)}, less the fee.`);
      return;
    }
    if (!held && after < kept) {
      refuse(`A vault keeps ${of(kept)} for its recovery, so at most ${of(has - fee - kept)}.`);
      return;
    }
    amountHint.textContent = `${feeText} Leaves ${of(after)}.`;
  };
  to.addEventListener("input", checkTo);
  amount.addEventListener("input", checkAmount);
  asset.addEventListener("change", checkAmount);
  const max = word(
    "Max",
    () => {
      const held = chosen();
      amount.value = held
        ? f.amount(held.balance ?? "0", held.token.decimals)
        : f.amount(wallet.maxAmount(saved, status, account));
      checkAmount();
    },
    `${TINY} absolute top-1/2 right-2 -translate-y-1/2`,
  );
  checkTo();
  checkAmount();
  const review = h("button", { type: "submit" }, "Review");
  const form = h(
    "form",
    null,
    sc.held.length ? field("What", asset) : null,
    h("div", { class: "grid gap-1" }, field("To", to), toHint),
    h("div", { class: "grid gap-1" }, field("Amount", h("div", { class: "relative" }, amount, max)), amountHint),
    h("div", { class: "mt-1 flex flex-wrap items-center gap-2.5" }, review, back(sc)),
  );
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    try {
      const held = chosen();
      const typed: Typed = { to: to.value, amount: amount.value, ...(held ? { token: held.token } : {}) };
      if (held) {
        const { payload, sent } = wallet.tokenTransfer(to.value, amount.value, held.token);
        showReview(sc, { payload, to: sent.to, amount: sent.amount, sent, typed });
      } else {
        const payload = wallet.transfer(to.value, amount.value);
        showReview(sc, { payload, to: payload.transfer.to, amount: payload.transfer.amount, sent: null, typed });
      }
    } catch (error) {
      say(messageOf(error), "error");
    }
  });
  show(drop(330, 520, 150), h("div", { class: "mt-8" }, ...title("Send", "It leaves with the next block.")), form);
}

function showReceive(sc: Screen): void {
  const address = sc.me.info.address;
  const groups: string[] = [];
  for (let i = 0; i < address.length; i += 16) groups.push(address.slice(i, i + 16));
  const copy = word(
    "Copy the address",
    async () => {
      await navigator.clipboard.writeText(address);
      copy.textContent = "Copied";
    },
    PRIMARY,
  );
  show(
    drop(310, 90, 100),
    h("div", { class: "mt-28" }, ...title("Receive", "Share this address. Coins arrive the moment a block includes them.")),
    h("div", { class: "mt-4 font-mono text-[1rem] leading-[1.55]" }, groups.map((g) => h("div", null, g))),
    h("div", { class: WORDS }, copy, back(sc)),
  );
}

function showActivity(sc: Screen): void {
  const entries = sc.wallet.activity(sc.saved);
  const now = Date.now();
  if (!entries.length) {
    show(
      drop(40, 600, 110),
      h("div", { class: "mt-8" }, ...title("Activity", "Nothing has been sent from this account yet.")),
      h("div", { class: WORDS }, word("Send", () => showSend(sc), PRIMARY), back(sc)),
    );
    return;
  }
  const list: HTMLElement[] = [];
  let lastDay = "";
  for (const a of entries) {
    const day = dayName(a.at, now);
    if (day !== lastDay) {
      list.push(h("p", { class: `${LABEL} mt-5 mb-0.5` }, day));
      lastDay = day;
    }
    list.push(activityRow(sc, a, timeOf(a.at)));
  }
  show(drop(40, 600, 110), h("div", { class: "mt-8" }, ...title("Activity")), ...list, h("div", { class: WORDS }, back(sc)));
}

function showActivityDetail(sc: Screen, a: Activity): void {
  const { text } = outcome(a);
  const transfer = "transfer" in a.payload ? a.payload.transfer : null;
  const rows: Row[] = [["status", text, a.status === "failed"], ["sent", clock(a.at)]];
  if (a.token) {
    rows.push(["to", whoIs(sc, a.token.to)]);
    rows.push(["amount", tokenAmount(a.token.amount, a.token)]);
  }
  if (transfer) {
    rows.push(["to", whoIs(sc, transfer.to)]);
    rows.push(["amount", f.amount(transfer.amount)]);
  }
  rows.push(["fee, burned", f.brief(a.fee)]);
  rows.push(["id", h("a", { href: explorerUrl(a.id), target: "_blank", rel: "noopener", title: a.id }, mono(f.short(a.id, 14, 10)))]);
  if (a.role === "recovery") rows.push(["signed with", "the recovery key"]);
  if (a.site) rows.push(["asked by", hostOf(a.site)]);
  const again =
    a.status === "sent"
      ? word("Check again", async () => {
          const settled = await sc.wallet.settle(sc.saved);
          showActivityDetail({ ...sc, saved: settled }, settled.activity.find((entry) => entry.id === a.id) ?? a);
        })
      : null;
  show(
    drop(60, 330, 120, true),
    h("p", { class: `${LABEL} mt-8 mb-0` }, dayName(a.at, Date.now())),
    h("p", { class: "my-0 font-display text-[1.7rem] leading-tight" }, describe(sc, a)),
    ledger(rows, "mt-4"),
    h("div", { class: WORDS }, again, out("Open in explorer", explorerUrl(a.id)), word("Activity", () => showActivity(sc)), back(sc)),
  );
}

function showAccounts(sc: Screen): void {
  const { wallet, core, saved, me } = sc;
  const client = wallet.client(saved);
  const balances = new Map<string, HTMLElement>();
  const rows = saved.accounts.map((a, i) => {
    const bal = h("span", null, "…");
    balances.set(a.info.address, bal);
    const active = i === saved.active;
    return row({
      main: h(
        "span",
        { class: "flex items-baseline gap-2.5" },
        h("span", { class: `inline-block h-1.5 w-1.5 shrink-0 rounded-full ${active ? "bg-ready" : ""}`, "aria-hidden": "true" }),
        a.name,
      ),
      sub: h("span", { class: "ml-4 font-mono" }, f.short(a.info.address, 12, 8)),
      right: h("span", { class: "text-[0.8rem] text-bone" }, bal),
      onClick: active
        ? undefined
        : async () => {
            const updated = await wallet.switchAccount(saved, i);
            await open(wallet, core, updated, "home");
          },
    });
  });
  void Promise.all(
    saved.accounts.map(async (a) => {
      try {
        balances.get(a.info.address)!.textContent = balanceOf(await client.account(a.info.address));
      } catch {
        balances.get(a.info.address)!.textContent = "?";
      }
    }),
  );

  const name = h("input", { type: "text", autocomplete: "off", required: "", maxlength: "32" });
  name.value = me.name;
  const rename = h("button", { type: "submit", class: QUIET }, "Rename");
  const form = h("form", { class: "mt-6" }, field(`Name of ${me.name}`, name), h("div", { class: "mt-1" }, rename));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void busy(rename, "Renaming…", async () => {
      const updated = await wallet.renameAccount(saved, saved.active, name.value);
      say("Renamed.", "done");
      await open(wallet, core, updated, "accounts");
    });
  });

  const file = h("input", { type: "file", accept: ".json,application/json", class: "hidden" });
  file.addEventListener("change", async () => {
    const chosen = file.files?.[0];
    if (!chosen) return;
    try {
      await wallet.importKeyFile(await chosen.text());
      say("Key imported.", "done");
      await open(wallet, core, (await wallet.load())!, "home");
    } catch (error) {
      say(messageOf(error), "error");
    }
  });

  show(
    drop(310, 90, 100),
    h("div", { class: "mt-8" }, ...title("Accounts")),
    ...rows,
    form,
    h(
      "div",
      { class: WORDS },
      word("Create a new key", () => showSetup(wallet, core, saved), PRIMARY),
      word("Import a key file", () => file.click()),
      file,
      back(sc),
    ),
  );
}

function settingsBody(wallet: Wallet, core: Core, saved: Saved, after: (updated: Saved) => Promise<void>): HTMLElement[] {
  const me = wallet.account(saved);
  const node = h("input", { type: "url", value: saved.nodeUrl, required: "" });
  const saveNode = h("button", { type: "submit", class: QUIET }, "Save the node");
  const nodeForm = h("form", null, field("Node address", node), h("div", null, saveNode));
  nodeForm.addEventListener("submit", (e) => {
    e.preventDefault();
    void busy(saveNode, "Saving…", async () => {
      const updated = await wallet.setNode(saved, node.value);
      say("Node saved.", "done");
      await after(updated);
    });
  });
  // Removing a key is the one thing that always asks for its password, unlocked or not.
  const removeBox = h("div", null);
  const remove = word(
    `Remove ${me.name} from this browser`,
    () => {
      const password = passwordInput();
      const confirm = h("button", { type: "submit", class: DANGER }, "Remove it for good");
      const form = h(
        "form",
        { class: "mt-3" },
        field("Its password, to be sure", password, "Have you saved its key file? Without the file, the coins are gone."),
        h("div", { class: "flex flex-wrap items-center gap-2.5" }, confirm, word("Keep it", () => removeBox.replaceChildren(), QUIET)),
      );
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        void busy(confirm, "Removing…", async () => {
          if (!wallet.verify(saved, password.value)) throw new WalletError("Wrong password.");
          const left = await wallet.removeAccount(saved, saved.active);
          await wallet.lock();
          say(`${me.name} removed from this browser.`);
          if (left) await start(wallet, core);
          else showSetup(wallet, core);
        });
      });
      removeBox.replaceChildren(form);
      password.focus();
    },
    DANGER,
  );
  return [
    nodeForm,
    h(
      "div",
      { class: "mt-7 grid gap-3" },
      h("div", null, h("p", { class: `${LABEL} my-0` }, `Key of ${me.name}`), h("p", { class: "my-0 text-[0.85rem]" }, me.info.scheme)),
      h("div", null, h("p", { class: `${LABEL} my-0` }, "Public key"), mono(f.short(me.info.public_key, 12, 8), me.info.public_key)),
    ),
    h(
      "div",
      { class: WORDS },
      word("Download the key file", () => download(`qubits-key-${me.info.address.slice(3, 11)}.json`, me.keystore)),
    ),
    h("div", { class: "mt-5" }, remove),
    removeBox,
  ];
}

function showSettings(sc: Screen): void {
  show(
    drop(40, 600, 110, true),
    h("div", { class: "mt-8" }, ...title("Settings")),
    ...settingsBody(sc.wallet, sc.core, sc.saved, (updated) => open(sc.wallet, sc.core, updated, "home")),
    h(
      "div",
      { class: WORDS },
      word("Sites", () => showSites(sc)),
      word("Accounts", () => showAccounts(sc)),
      word("Log out", () => void logOut(sc.wallet, sc.core, sc.saved), QUIET),
      back(sc),
    ),
  );
}

function showUnreachable(wallet: Wallet, core: Core, saved: Saved, why: string): void {
  chainLine.textContent = "no node";
  who.hidden = true;
  show(
    drop(250, 170, 184, true),
    h(
      "div",
      { class: "mt-16 flex h-[220px] flex-col items-center justify-center text-center" },
      h("p", { class: "my-0 font-display text-[1.5rem]" }, "The node can't be reached"),
      h("p", { class: "my-1 px-6 text-[0.8rem] text-soft" }, `${why} Check the address below, or start the node.`),
    ),
    h("div", { class: "mt-2" }, word("Try again", () => void open(wallet, core, saved, "home"), PRIMARY)),
    ...settingsBody(wallet, core, saved, (updated) => open(wallet, core, updated, "home")),
  );
}

/** Asks for the password of the account in use; afterwards the wallet stays unlocked for a while. */
function showUnlock(wallet: Wallet, core: Core, saved: Saved, then?: () => Promise<void> | void): void {
  clearTimeout(lockTimer);
  const me = wallet.account(saved);
  chainLine.textContent = "locked";
  who.hidden = true;
  logOutButton.hidden = true;
  const password = passwordInput();
  const unlock = h("button", { type: "submit" }, "Unlock");
  const form = h(
    "form",
    null,
    field(`Password of ${me.name}`, password),
    h(
      "div",
      { class: "mt-1 flex flex-wrap items-center gap-2.5" },
      unlock,
      saved.accounts.length > 1 && !asking ? word("Another account", () => showPick(wallet, core, saved), QUIET) : null,
    ),
  );
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void busy(unlock, "Unlocking…", async () => {
      await wallet.unlock(saved, password.value);
      password.value = "";
      say("");
      if (then) await then();
      else await open(wallet, core, saved, "home");
    });
  });
  show(
    drop(180, 150, 110),
    h("p", { class: "mt-24 text-center font-display text-[1.9rem] text-bone" }, me.info.address.slice(0, 7)),
    h("div", { class: "mt-12" }, ...title("Unlock")),
    form,
  );
  setTimeout(() => password.focus(), 50);
}

/** The accounts, for choosing one while locked: names and addresses, nothing from the node. */
function showPick(wallet: Wallet, core: Core, saved: Saved): void {
  const rows = saved.accounts.map((a, i) =>
    row({
      main: h(
        "span",
        { class: "flex items-baseline gap-2.5" },
        h("span", { class: `inline-block h-1.5 w-1.5 shrink-0 rounded-full ${i === saved.active ? "bg-ready" : ""}`, "aria-hidden": "true" }),
        a.name,
      ),
      sub: h("span", { class: "ml-4 font-mono" }, f.short(a.info.address, 12, 8)),
      onClick: async () => showUnlock(wallet, core, await wallet.switchAccount(saved, i)),
    }),
  );
  show(
    drop(310, 90, 100),
    h("div", { class: "mt-8" }, ...title("Accounts")),
    ...rows,
    h("div", { class: WORDS }, word("Back", () => showUnlock(wallet, core, saved), QUIET)),
  );
}

/** The site's request this window was opened for. */
let asking: PendingRequest | null = null;
/** So a click meant for the page, as this window opens under the mouse, can't land on "Approve". */
const APPROVE_AFTER_MS = 900;

function hostOf(origin: string): string {
  return origin.replace(/^https:\/\//, "");
}

async function closeAnswering(
  request: PendingRequest,
  reply: { result: unknown } | { error: { code: number; message: string } },
): Promise<void> {
  await answer(request, reply);
  window.close();
}

function refuseWord(request: PendingRequest, text = "Refuse"): HTMLButtonElement {
  const message = "The user refused.";
  return word(text, () => void closeAnswering(request, { error: { code: REFUSED, message } }), QUIET);
}

function armed(button: HTMLButtonElement): HTMLButtonElement {
  button.disabled = true;
  setTimeout(() => {
    button.disabled = false;
  }, APPROVE_AFTER_MS);
  return button;
}

async function showRequest(wallet: Wallet, core: Core, id: string): Promise<void> {
  const request = (await pendingRequests())[id];
  if (!request) {
    window.close();
    return;
  }
  asking = request;
  const saved = await wallet.load();
  if (!saved) {
    const error = { code: UNAVAILABLE, message: "The wallet has no account yet." };
    await closeAnswering(request, { error });
    return;
  }
  const go = async () => {
    const sc = await screenOf(wallet, core, saved);
    if (!sc) return;
    who.onclick = null;
    if (request.method === "qb_connect") showConnect(sc, request);
    else await showCallRequest(sc, request);
  };
  if (await wallet.unlocked(saved)) await go();
  else showUnlock(wallet, core, saved, go);
}

function showConnect(sc: Screen, request: PendingRequest): void {
  const { wallet, saved, me } = sc;
  const connect = word(
    "Connect",
    () =>
      void busy(connect, "Connecting…", async () => {
        await wallet.connectSite(saved, request.origin);
        await closeAnswering(request, { result: [me.info.address] });
      }),
    PRIMARY,
  );
  show(
    drop(70, 140, 110),
    h("p", { class: `${LABEL} mt-8 mb-0` }, "a website asks to connect"),
    h("p", { class: "my-0 font-display text-[1.9rem] leading-tight break-all" }, hostOf(request.origin)),
    ledger(
      [
        ["account", h("span", null, me.name, h("span", { class: "ml-2 text-soft" }, f.short(me.info.address, 12, 6)))],
        ["it will see", "this address and what it holds"],
      ],
      "mt-4",
    ),
    h(
      "p",
      { class: "mt-4 mb-0 text-[0.85rem] text-soft" },
      "It can ask you to approve things, one at a time. It can't move anything without you.",
    ),
    h("div", { class: WORDS }, armed(connect), refuseWord(request)),
  );
}

async function showCallRequest(sc: Screen, request: PendingRequest): Promise<void> {
  const { wallet, core, saved, status, account, me } = sc;
  const call = request.call;
  if (!call || !wallet.isConnected(saved, request.origin)) {
    const message = "Connect first: the account in use hasn't agreed to this site.";
    await closeAnswering(request, { error: { code: NOT_CONNECTED, message } });
    return;
  }

  // What the site says doesn't matter: this is the chain's own answer about this account.
  const client = wallet.client(saved);
  const caller = { caller: me.info.address, amount: call.amount };
  let simulated: ViewResponse;
  try {
    simulated = await client.view(call.contract, call.function, call.args, caller);
  } catch (error) {
    await closeAnswering(request, { error: { code: UNAVAILABLE, message: messageOf(error) } });
    return;
  }
  const failed = failureOf({ receipt: simulated });
  if (failed) {
    const message = `This call would fail: ${failed}.`;
    const close = () => void closeAnswering(request, { error: { code: WOULD_FAIL, message } });
    show(
      drop(60, 330, 120, true),
      h("p", { class: `${LABEL} mt-8 mb-0` }, `${hostOf(request.origin)} asks you to`),
      h("p", { class: "my-0 font-display text-[1.9rem] leading-tight" }, `Call ${call.function}`),
      marked("This would fail, so nothing was sent.", failed),
      h("div", { class: WORDS }, word("Close", close, PRIMARY)),
    );
    return;
  }

  const coins = balanceIn(account);
  const nativeChange = BigInt(simulated.balance_after) - coins;
  const changes = changesOf(simulated, me.info.address);
  const touched = [...changes.tokens.keys(), ...changes.approvals.map((a) => a.token)];
  const known = new Map<Address, Token>();
  for (const contract of new Set(touched)) {
    const listed = sc.held.find((x) => x.token.contract === contract)?.token;
    const token = listed ?? (await wallet.tokenInfo(saved, status.genesis_hash, contract).catch(() => null));
    if (token) known.set(contract, token);
  }
  const shown = (contract: Address, units: bigint) => {
    const token = known.get(contract);
    return token ? tokenAmount(units.toString(), token) : `${units} of ${f.short(contract, 8, 5)}`;
  };

  const payload: ContractCall = {
    call: {
      contract: call.contract,
      function: call.function,
      args: call.args,
      amount: call.amount,
      gas_limit: gasFor(simulated.gas_used, MAX_TX_GAS),
    },
  };
  const fee = wallet.callFeeEstimate(saved, status, account, payload.call);
  const lacking = coins + nativeChange < fee;
  const rows: Row[] = [
    ["site", hostOf(request.origin)],
    ["contract", known.get(call.contract)?.name ?? f.short(call.contract, 26, 8)],
  ];
  if (nativeChange < 0n) rows.push(["you pay", `${f.brief((-nativeChange).toString())} Qubits`]);
  for (const [contract, change] of changes.tokens) {
    if (change < 0n) rows.push(["you pay", shown(contract, -change)]);
  }
  if (nativeChange > 0n) rows.push(["you get", `${f.brief(nativeChange.toString())} Qubits`]);
  for (const [contract, change] of changes.tokens) {
    if (change > 0n) rows.push(["you get", shown(contract, change)]);
  }
  rows.push(["fee at most, the rest comes back", f.brief(fee.toString()), lacking]);
  if (account.vault) rows.push(["leaves", `after the vault's ${delayText(account.vault.delay_ms)}`]);

  const approve = word(
    "Approve",
    () =>
      void busy(approve, "Sending…", async () => {
        const session = await wallet.unlocked(saved);
        if (!session) {
          showUnlock(wallet, core, saved, () => showCallRequest(sc, request));
          return;
        }
        try {
          const prepared = await wallet.prepare(saved, session.password, "owner", payload);
          const id = await wallet.submit(saved, prepared);
          await wallet.record(saved, prepared, Date.now(), { site: request.origin });
          await closeAnswering(request, { result: { id } });
        } catch (error) {
          await closeAnswering(request, { error: { code: UNAVAILABLE, message: messageOf(error) } });
        }
      }),
    PRIMARY,
  );
  show(
    drop(60, 330, 120, true),
    h("p", { class: `${LABEL} mt-6 mb-0` }, `${hostOf(request.origin)} asks you to`),
    h("p", { class: "my-0 font-display text-[1.9rem] leading-tight" }, `Call ${call.function}`),
    ledger(rows, "mt-3"),
    ...changes.approvals.map(({ token, spender, amount }) =>
      marked(
        `Lets ${f.short(spender, 8, 5)} spend ${
          isUnlimited(amount) ? `all your ${known.get(token)?.symbol ?? "tokens"}, now and later` : shown(token, amount)
        }.`,
        "Only if you trust it.",
      ),
    ),
    lacking ? marked("Not enough coins for the fee.") : null,
    h("div", { class: WORDS }, lacking ? null : armed(approve), refuseWord(request)),
  );
}

function showSites(sc: Screen): void {
  const { wallet, core, saved, me } = sc;
  const sites = saved.sites.filter((s: Site) => s.address === me.info.address);
  const rows = sites.map((site) =>
    row({
      main: hostOf(site.origin),
      trailing: word(
        "Disconnect",
        async () => {
          const updated = await wallet.disconnectSite(saved, site);
          say(`${hostOf(site.origin)} can't see this account any more.`);
          await open(wallet, core, updated, "sites");
        },
        `${QUIET} ${TINY}`,
      ),
    }),
  );
  show(
    drop(300, 100, 120, true),
    h(
      "div",
      { class: "mt-8" },
      ...title("Sites", rows.length ? `These can see ${me.name} and ask you to approve things.` : "No website can see this account."),
    ),
    rows.length ? h("div", { class: "mt-3" }, ...rows) : null,
    h("div", { class: WORDS }, back(sc)),
  );
}

async function start(wallet: Wallet, core: Core): Promise<void> {
  const saved = await wallet.load();
  if (saved) await open(wallet, core, saved, "home");
  else showSetup(wallet, core);
}

async function main(): Promise<void> {
  const core = await loadCore();
  const inExtension = typeof chrome !== "undefined" && Boolean(chrome.storage?.local);
  const wallet = new Wallet(
    inExtension ? chromeStore() : localStore(),
    core,
    import.meta.env.VITE_QUBITS_RPC || "http://127.0.0.1:8545",
    undefined,
    inExtension ? chromeSessionStore() : pageSessionStore(),
  );
  const request = new URLSearchParams(location.search).get("request");
  if (request && inExtension) await showRequest(wallet, core, request);
  else await start(wallet, core);
}

main().catch((error) => say(`The wallet failed to start: ${messageOf(error)}`, "error"));
