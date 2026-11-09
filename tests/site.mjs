// The wallet and a website, for real: Chrome with the built extension loaded, pages over https
// under the names the wallet cares about, and a local chain whose files are in QUBITS_DEMO
// (default ~/qubits-demo). It checks who gets
// `window.qubits`, then walks connecting, reading, approving and refusing, with real transactions.
//
//   npm run build && node tests/site.mjs
//
// Needs that chain running, with `token` and `amm` in its contracts.txt. Pictures of the
// approval windows go to $TMPDIR/qubits-site (or SHOTS_OUT). EXTENSION tests another build, such
// as an unpacked store zip.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer as createHttp } from "node:http";
import { createServer as createHttps } from "node:https";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEMO = process.env.QUBITS_DEMO ?? `${homedir()}/qubits-demo`;
const CHAIN = process.env.QUBITS_CHAIN ?? resolve(ROOT, existsSync(resolve(ROOT, "chain/Cargo.toml")) ? "chain" : "../chain");
const QUBITS = process.env.QUBITS_CLI ?? resolve(CHAIN, "target/release/qubits");
const OUT = `${(process.env.SHOTS_OUT ?? `${tmpdir().replace(/\/$/, "")}/qubits-site`).replace(/\/$/, "")}/`;
const NODE = "http://127.0.0.1:8545";
const ONE_TOKEN = "1000000000000000000";
const TWO_TOKENS = "2000000000000000000";
const HTTPS_PORT = 8743;
const HTTP_PORT = 8744;

const password = readFileSync(`${DEMO}/pw`, "utf8").trim();
const contracts = readFileSync(`${DEMO}/contracts.txt`, "utf8");
const TOKEN = contracts.match(/^token (\S+)/m)[1];
const AMM = contracts.match(/^amm (\S+)/m)[1];
const key = (file) => readFileSync(`${DEMO}/${file}`, "utf8");
const addressOf = (file) =>
  execFileSync(QUBITS, ["address", "--key", `${DEMO}/${file}`], { encoding: "utf8" }).trim();
const ME = addressOf("wallet-key.json");
const ALICE = addressOf("friend.json");
const info = {
  address: ME,
  public_key: execFileSync(QUBITS, ["key", "show", "--key", `${DEMO}/wallet-key.json`], { encoding: "utf8" }).match(/[0-9a-f]{100,}/)?.[0],
  scheme: "ml-dsa-65",
};
const { genesis_hash } = await (await fetch(`${NODE}/v1/status`)).json();

let passed = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) passed++;
  else failures.push(name);
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok || detail === "" ? "" : `  [${JSON.stringify(detail)}]`}`);
}

// A certificate for every name, and one small page.
const scratch = mkdtempSync(join(tmpdir(), "qubits-site-"));
execFileSync(
  "openssl",
  ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${scratch}/key`, "-out", `${scratch}/cert`, "-days", "2",
    "-subj", "/CN=qubits.sh", "-addext", "subjectAltName=DNS:qubits.sh,DNS:*.qubits.sh,DNS:evil.example,DNS:evilqubits.sh"],
  { stdio: "ignore" },
);
const page = (req, res) => {
  res.setHeader("content-type", "text/html");
  const frame = req.url === "/framed" ? '<iframe id="inner" src="https://explorer.qubits.sh/"></iframe>' : "";
  res.end(`<!doctype html><title>${req.headers.host}</title><h1>${req.headers.host}</h1>${frame}`);
};
const secure = createHttps({ key: readFileSync(`${scratch}/key`), cert: readFileSync(`${scratch}/cert`) }, page);
await new Promise((done) => secure.listen(HTTPS_PORT, "127.0.0.1", done));
const plain = createHttp(page);
await new Promise((done) => plain.listen(HTTP_PORT, "127.0.0.1", done));

mkdirSync(OUT, { recursive: true });
const map = (host) => `MAP ${host} 127.0.0.1:${HTTPS_PORT}`;
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  enableExtensions: [process.env.EXTENSION ?? resolve(ROOT, "dist")],
  acceptInsecureCerts: true,
  defaultViewport: null,
  args: [
    "--no-first-run",
    `--host-resolver-rules=${["qubits.sh", "*.qubits.sh", "evil.example", "evilqubits.sh"].map(map).join(",")}`,
  ],
});

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

async function site(url) {
  const tab = await browser.newPage();
  await tab.goto(url, { waitUntil: "load" });
  return tab;
}

/** Runs a `window.qubits` call in the page; rejections come back as `{ code, message }`. */
const ask = (tab, call, ...args) =>
  tab.evaluate(
    `(async (args) => { try { return { ok: await (${call})(...args) }; } catch (e) { return { code: e.code, message: e.message, name: e.name }; } })(${JSON.stringify(args)})`,
  );

const seenWindows = new Set();

/** The approval window of the newest request: an old one may still be on its way out. */
async function approval() {
  const fresh = (t) => t.url().includes("?request=") && !seenWindows.has(t.url());
  const target = await browser.waitForTarget(fresh, { timeout: 15_000 });
  seenWindows.add(target.url());
  const window = await target.asPage();
  await window.setViewport({ width: 360, height: 600, deviceScaleFactor: 2 });
  return window;
}

const closed = (window) =>
  new Promise((done) => {
    if (window.isClosed()) done();
    else window.once("close", done);
  });

const buttonNamed = (window, text) =>
  window.evaluateHandle((t) => [...document.querySelectorAll("button")].find((b) => !b.hidden && b.textContent.trim() === t) ?? null, text);

async function untilButton(window, text) {
  await window.waitForFunction(
    (t) => [...document.querySelectorAll("button")].some((b) => !b.hidden && b.textContent.trim() === t),
    { timeout: 20_000 },
    text,
  );
}

async function press(window, text) {
  await window.waitForFunction(
    (t) => [...document.querySelectorAll("button")].some((b) => !b.hidden && !b.disabled && b.textContent.trim() === t),
    { timeout: 20_000 },
    text,
  );
  const handle = await buttonNamed(window, text);
  await handle.asElement().click();
}

const shot = async (window, name) => {
  await wait(900);
  await window.screenshot({ path: `${OUT}${name}.png` });
  console.log(`  shot  ${name}`);
};

const text = (window) => window.evaluate(() => document.body.innerText);

async function landed(tab, id) {
  let seen;
  for (let i = 0; i < 60; i++) {
    seen = await ask(tab, "window.qubits.transaction", id);
    if (seen.ok?.status === "included") break;
    await wait(200);
  }
  return seen;
}

try {
  const worker = await browser.waitForTarget((t) => t.type() === "service_worker", { timeout: 15_000 });
  const id = new URL(worker.url()).host;
  check("the extension loads in Chrome, with its worker", Boolean(id));

  for (const url of ["https://qubits.sh/", "https://app.qubits.sh/", "https://a.b.qubits.sh/"]) {
    const tab = await site(url);
    const has = await tab.evaluate(() => window.qubits?.isQubits === true);
    check(`${url} has window.qubits`, has);
    await tab.close();
  }
  for (const url of ["https://evil.example/", "https://evilqubits.sh/", `http://127.0.0.1:${HTTP_PORT}/`]) {
    const tab = await site(url);
    const seen = await tab.evaluate(() => ({ qubits: typeof window.qubits, runtime: typeof window.chrome?.runtime?.sendMessage }));
    check(`${url} has no window.qubits and no way in`, seen.qubits === "undefined" && seen.runtime === "undefined", seen);
    await tab.close();
  }

  const framed = await site("https://app.qubits.sh/framed");
  await wait(500);
  const inner = framed.frames().find((f) => f.url().includes("explorer.qubits.sh"));
  check("a frame inside a site gets nothing", inner && (await inner.evaluate(() => typeof window.qubits)) === "undefined");
  await framed.close();

  const portTab = await site(`https://qubits.sh:${HTTPS_PORT}/`);
  const onPort = await ask(portTab, "window.qubits.accounts");
  check("another port is another site, and refused", onPort.code === 4900, onPort);
  await portTab.close();

  const frozen = await site("https://app.qubits.sh/");
  const tampered = await frozen.evaluate(() => {
    try {
      window.qubits = { isQubits: false };
      window.qubits.request = null;
    } catch {
      // strict pages throw; either way it must not stick
    }
    return window.qubits.isQubits === true && typeof window.qubits.request === "function";
  });
  check("window.qubits can't be replaced", tampered);
  await frozen.close();

  const before = await site("https://app.qubits.sh/");
  const none = await ask(before, "window.qubits.connect");
  check("with no account yet the site is told so", none.code === 4900 && /no account/.test(none.message), none);
  await before.close();

  // The test wallet, in the extension's own storage, locked.
  const home = await browser.newPage();
  await home.goto(`chrome-extension://${id}/popup.html`, { waitUntil: "load" });
  await home.evaluate(
    (saved) => chrome.storage.local.set({ wallet: saved }),
    {
      version: 2,
      accounts: [{ name: "Main", keystore: key("wallet-key.json"), info }],
      active: 0,
      nodeUrl: NODE,
      activity: [],
      tokens: [],
      sites: [],
    },
  );

  const app = await site("https://app.qubits.sh/");
  check("nothing is connected at first", (await ask(app, "window.qubits.accounts")).ok?.length === 0);
  const early = await ask(app, "window.qubits.call", { contract: TOKEN, function: "transfer", args: [ALICE, "1"] });
  check("a call before connecting is refused", early.code === 4100, early);
  const chain = await ask(app, "window.qubits.chain");
  check("anyone here can read the chain", chain.ok?.genesis_hash === genesis_hash, chain);

  const connecting = ask(app, "window.qubits.connect");
  let window = await approval();
  await window.waitForSelector("input[type=password]");
  await shot(window, "01-locked");
  await window.type("input[type=password]", "not the password at all");
  await press(window, "Unlock");
  await window.waitForFunction(() => /Wrong password/.test(document.getElementById("status").textContent));
  check("a locked wallet asks for the password first", true);
  await wait(3_600);
  check("an error stays until it is dealt with", /Wrong password/.test(await window.$eval("#status", (el) => el.textContent)));
  await window.$eval("input[type=password]", (el) => el.select());
  await window.type("input[type=password]", password);
  await press(window, "Unlock");
  await untilButton(window, "Connect");
  check("a right password clears it, and says nothing", (await window.$eval("#status", (el) => el.textContent)) === "");
  const asking = await text(window);
  check("the window says who is asking, and for which account", asking.includes("app.qubits.sh") && asking.includes("Main"), asking);
  const hasty = await window.evaluate(
    () => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Connect").disabled,
  );
  check("approving is held back a moment, against a stray click", hasty);
  await shot(window, "02-connect");
  await press(window, "Connect");
  const connected = await connecting;
  check("connecting gives the address", connected.ok?.[0] === ME, connected);
  await closed(window);
  check("and the site remembers", (await ask(app, "window.qubits.accounts")).ok?.[0] === ME);

  const again = await ask(app, "window.qubits.connect");
  check("connecting again asks nothing", again.ok?.[0] === ME, again);

  const other = await site("https://qubits.sh/");
  check("another subdomain is another site", (await ask(other, "window.qubits.accounts")).ok?.length === 0);
  const refusing = ask(other, "window.qubits.connect");
  window = await approval();
  await untilButton(window, "Refuse");
  await press(window, "Refuse");
  const refused = await refusing;
  check("refusing tells the site", refused.code === 4001, refused);

  const closing = ask(other, "window.qubits.connect");
  window = await approval();
  await untilButton(window, "Refuse");
  await window.close();
  const shut = await closing;
  check("closing the window is an answer too", shut.code === 4001, shut);
  await other.close();

  const quote = await ask(app, "window.qubits.view", {
    contract: AMM,
    function: "quote",
    args: ["native", TOKEN, ONE_TOKEN],
  });
  check("a site reads a contract through the wallet", quote.ok?.outcome === "done" && quote.ok.output.length === 32, quote);

  for (const [what, params] of [
    ["init", { contract: TOKEN, function: "init" }],
    ["a broken address", { contract: "qb1nope", function: "transfer" }],
    ["a broken amount", { contract: TOKEN, function: "transfer", args: [ALICE, "1"], amount: "lots" }],
    ["an unreadable argument", { contract: TOKEN, function: "transfer", args: ["what"] }],
  ]) {
    const bad = await ask(app, "window.qubits.call", params);
    check(`${what} never reaches a window`, bad.code === -32602, bad);
  }
  const unknown = await ask(app, "window.qubits.request", { method: "eth_sendTransaction" });
  check("what the wallet doesn't know, it says", unknown.code === 4200, unknown);

  const poolBefore = await ask(app, "window.qubits.view", { contract: AMM, function: "pool", args: [TOKEN, "native"] });

  // what would fail doesn't get as far as an approve button
  const failing = ask(app, "window.qubits.call", { contract: TOKEN, function: "transfer", args: [ALICE, "99999999999999999999"] });
  window = await approval();
  await untilButton(window, "Close");
  check("a call that would fail says why", /balance too low/.test(await text(window)));
  check("and can't be approved", (await buttonNamed(window, "Approve")).asElement() === null);
  await shot(window, "03-would-fail");
  await press(window, "Close");
  const failed = await failing;
  check("the site hears it would fail", failed.code === 4300, failed);

  const first = ask(app, "window.qubits.call", {
    contract: AMM,
    function: "swap",
    args: ["native", TOKEN, TWO_TOKENS, "1", "deadline:600"],
    amount: TWO_TOKENS,
  });
  window = await approval();
  await untilButton(window, "Approve");
  const second = await ask(app, "window.qubits.call", { contract: TOKEN, function: "transfer", args: [ALICE, "1"] });
  check("a page can't stack up requests", second.code === 4900 && /already waiting/.test(second.message), second);
  const swapScreen = await text(window);
  check("the swap is shown from the simulation: what goes", /you pay\s+2 Qubits/i.test(swapScreen), swapScreen);
  check("and what comes", /you get\s+[\d.,]+ EXT/i.test(swapScreen), swapScreen);
  await shot(window, "04-swap");
  await press(window, "Refuse");
  const noSwap = await first;
  check("a refused call sends nothing", noSwap.code === 4001, noSwap);
  const unchanged = await ask(app, "window.qubits.view", { contract: AMM, function: "pool", args: [TOKEN, "native"] });
  check("the pool didn't move", unchanged.ok?.output === poolBefore.ok?.output);

  const swapping = ask(app, "window.qubits.call", {
    contract: AMM,
    function: "swap",
    args: ["native", TOKEN, TWO_TOKENS, "1", "deadline:600"],
    amount: TWO_TOKENS,
  });
  window = await approval();
  await press(window, "Approve");
  const sent = await swapping;
  check("an approved call gives its id", /^[0-9a-f]{64}$/.test(sent.ok?.id ?? ""), sent);
  await closed(window);
  let done;
  for (let i = 0; i < 60; i++) {
    done = await ask(app, "window.qubits.transaction", sent.ok.id);
    if (done.ok?.status === "included") break;
    await wait(200);
  }
  check("and it lands on the chain, done", done.ok?.receipt?.outcome === "done", done);
  const moved = await ask(app, "window.qubits.view", { contract: AMM, function: "pool", args: [TOKEN, "native"] });
  check("the pool moved", moved.ok?.output !== poolBefore.ok?.output);

  const making = ask(app, "window.qubits.call", {
    contract: AMM,
    function: "create",
    args: ['"Quantum Cat"', '"QCAT"', "500"],
    amount: ONE_TOKEN,
  });
  window = await approval();
  await untilButton(window, "Approve");
  const makeScreen = await text(window);
  check("making a token shows what goes, less the launcher's share that comes back", /you pay\s+0\.9975 Qubits/i.test(makeScreen), makeScreen);
  check("and what the first buy gets, of a token not made yet", /you get\s+[\d.,]+ (QCAT|of qb1)/i.test(makeScreen), makeScreen);
  await shot(window, "04b-create");
  await press(window, "Approve");
  const made = await making;
  await closed(window);
  check("a token made through the wallet lands, done", (await landed(app, made.ok?.id)).ok?.receipt?.outcome === "done", made);

  const coin = (await (await fetch(`${NODE}/v1/contracts`)).json()).contracts.at(-1);
  const allowing = ask(app, "window.qubits.call", { contract: coin, function: "approve", args: [AMM, "1000000000000000000000"] });
  window = await approval();
  await press(window, "Approve");
  const allowed = await allowing;
  await closed(window);
  await landed(app, allowed.ok?.id);
  const selling = ask(app, "window.qubits.call", {
    contract: AMM,
    function: "swap",
    args: [coin, "native", "1000000000000000000000", "1", "deadline:600"],
  });
  window = await approval();
  await untilButton(window, "Approve");
  const sellScreen = await text(window);
  check("selling it shows the Qubits that come back", /you get\s+[\d.]+ Qubits/i.test(sellScreen), sellScreen);
  await shot(window, "04c-sell");
  await press(window, "Approve");
  const sold = await selling;
  await closed(window);
  check("and the sale lands, done", (await landed(app, sold.ok?.id)).ok?.receipt?.outcome === "done", sold);

  const giving = ask(app, "window.qubits.call", {
    contract: TOKEN,
    function: "approve",
    args: [ALICE, "170141183460469231731687303715884105727"],
  });
  window = await approval();
  await untilButton(window, "Approve");
  const warned = await text(window);
  check("an unlimited approval is called what it is", /all your EXT, now and later/.test(warned), warned);
  await shot(window, "05-approve-everything");
  await press(window, "Refuse");
  await giving;

  const stored = await home.evaluate(async () => (await chrome.storage.local.get("wallet")).wallet);
  check("the wallet remembers who asked", stored.activity[0]?.site === "https://app.qubits.sh", stored.activity[0]);
  check("and which site it connected", stored.sites.some((s) => s.origin === "https://app.qubits.sh" && s.address === ME));
  const session = await home.evaluate(() => chrome.storage.session.get(null));
  check("no request is left behind", Object.keys(session["site-requests"] ?? {}).length === 0, session["site-requests"]);

  // a content script must not be able to read the kept password
  const access = await home.evaluate(() => chrome.storage.session.getAccessLevel?.() ?? "unknown");
  check("what is unlocked stays out of content scripts", access !== "TRUSTED_AND_UNTRUSTED_CONTEXTS", access);

  // a tab that goes away takes its request with it
  const leaving = await site("https://app.qubits.sh/");
  void ask(leaving, "window.qubits.call", { contract: TOKEN, function: "transfer", args: [ALICE, "1"] }).catch(() => {});
  window = await approval();
  await untilButton(window, "Approve");
  await leaving.close();
  await closed(window);
  check("closing the page closes its request", true);

  // logging out
  await home.bringToFront();
  await home.reload({ waitUntil: "load" });
  await home.setViewport({ width: 360, height: 600, deviceScaleFactor: 2 });
  await untilButton(home, "Log out");
  const found = await home
    .waitForFunction(() => /QCAT/.test(document.body.innerText), { timeout: 20_000 })
    .then(() => true, () => false);
  check("the wallet finds the token it made", found, await text(home));
  await shot(home, "05b-home");
  await press(home, "Log out");
  await untilButton(home, "Unlock");
  const unlocked = await home.evaluate(() => chrome.storage.session.get("unlocked"));
  check("logging out forgets the password", Object.keys(unlocked).length === 0, unlocked);
  await shot(home, "05c-logged-out");
  const keys = await home.evaluate(async () => (await chrome.storage.local.get("wallet")).wallet.accounts.length);
  check("the account is still here", keys === 1);
  check("and the site is still connected", (await ask(app, "window.qubits.accounts")).ok?.[0] === ME);
  const lockedCall = ask(app, "window.qubits.call", { contract: TOKEN, function: "transfer", args: [ALICE, "1"] });
  window = await approval();
  await window.waitForSelector("input[type=password]");
  check("after logging out a site's request asks for the password", true);
  check("and the window has no way to log out or switch account", await window.evaluate(() => document.getElementById("out").hidden));
  await window.type("input[type=password]", password);
  await press(window, "Unlock");
  await press(window, "Refuse");
  await lockedCall;

  // disconnecting
  await home.bringToFront();
  await home.reload({ waitUntil: "load" });
  await untilButton(home, "Settings");
  await press(home, "Settings");
  await press(home, "Sites");
  await untilButton(home, "Disconnect");
  await home.setViewport({ width: 360, height: 600, deviceScaleFactor: 2 });
  await shot(home, "06-sites");
  await press(home, "Disconnect");
  await home.waitForFunction(() => /No website can see/.test(document.body.innerText));
  check("a message saying it went well shows", /can't see this account/.test(await home.$eval("#status", (el) => el.textContent)));
  await home.waitForFunction(() => document.getElementById("status").textContent === "", { timeout: 4_000 });
  check("and goes away by itself", true);
  check("disconnecting takes the site's view away", (await ask(app, "window.qubits.accounts")).ok?.length === 0);
  const after = await ask(app, "window.qubits.call", { contract: TOKEN, function: "transfer", args: [ALICE, "1"] });
  check("and its calls with it", after.code === 4100, after);
} catch (error) {
  failures.push("the walk stopped");
  console.error(error);
} finally {
  await browser.close();
  secure.close();
  plain.close();
}

console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? `: ${failures.join("; ")}` : ""}`);
process.exit(failures.length ? 1 : 0);
