// Screenshots of every popup screen in headless Chrome, against a local chain whose key files are in
// QUBITS_DEMO (default ~/qubits-demo): wallet-key.json, friend.json, validator.json, recovery.json
// and the password in pw. Run `npm run dev` first. Activity is seeded from what the account sent in the newest blocks;
// `--send` also sends 1 coin to Alice (friend.json) and pictures the home screen afterwards.
//
//   node tests/shots.mjs [--send]
//
// The pictures land in $TMPDIR/qubits-shots (or SHOTS_OUT). The page is the dev server's popup.html, which
// keeps the wallet in localStorage, so the demo key is seeded there before the page loads.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PAGE = process.env.SHOTS_URL ?? "http://localhost:5173/popup.html";
const NODE = process.env.QUBITS_RPC ?? "http://127.0.0.1:8545";
const DEMO = process.env.QUBITS_DEMO ?? `${homedir()}/qubits-demo`;
const CHAIN =
  process.env.QUBITS_CHAIN ??
  fileURLToPath(new URL(existsSync(new URL("../chain/Cargo.toml", import.meta.url)) ? "../chain" : "../../chain", import.meta.url));
const CLI = process.env.QUBITS_CLI ?? `${CHAIN}/target/release/qubits`;
// Pictures go outside the project unless SHOTS_OUT says otherwise.
const OUT = `${(process.env.SHOTS_OUT ?? `${(process.env.TMPDIR ?? "/tmp").replace(/\/$/, "")}/qubits-shots`).replace(/\/$/, "")}/`;
const send = process.argv.includes("--send");

function keyInfo(file) {
  const shown = execFileSync(CLI, ["key", "show", "--key", file], { encoding: "utf8" });
  const pick = (label) => new RegExp(`^${label}:\\s*(\\S+)`, "m").exec(shown)?.[1];
  const address = execFileSync(CLI, ["address", "--key", file], { encoding: "utf8" }).trim().split(/\s+/).pop();
  return { scheme: pick("scheme"), public_key: pick("public key"), address };
}

const me = keyInfo(`${DEMO}/wallet-key.json`);
const friend = keyInfo(`${DEMO}/friend.json`);
const empty = keyInfo(`${DEMO}/validator.json`);
const stranger = keyInfo(`${DEMO}/recovery.json`);
const password = readFileSync(`${DEMO}/pw`, "utf8").trim();
/** What this account sent in the newest blocks, as the wallet would have remembered it. */
async function sentFromChain(address, blocks = 32) {
  const get = async (path) => (await fetch(`${NODE}${path}`)).json();
  const { height } = await get("/v1/status");
  const activity = [];
  for (let h = height; h >= 1 && h > height - blocks; h--) {
    const block = await get(`/v1/blocks/${h}`);
    block.transactions.forEach((signed, i) => {
      if (signed.tx.sender !== address) return;
      const { payload, role, fee } = signed.tx;
      activity.push({ id: block.transaction_ids[i], at: block.timestamp_ms, account: address, payload, role, fee, status: "included", height: h });
    });
  }
  return activity;
}

const seed = {
  version: 2,
  accounts: [
    { name: "Main", keystore: readFileSync(`${DEMO}/wallet-key.json`, "utf8"), info: me },
    { name: "Empty", keystore: readFileSync(`${DEMO}/validator.json`, "utf8"), info: empty },
  ],
  active: 0,
  nodeUrl: NODE,
  activity: await sentFromChain(me.address),
};

mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-first-run"] });
const page = await browser.newPage();
await page.setViewport({ width: 360, height: 600, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.error("page error:", e.message));
page.on("console", (m) => {
  if (m.type() === "error" && !m.text().includes("404")) console.error("console:", m.text());
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const taken = [];
async function shot(name) {
  await wait(1_000); // the drop takes 0.7 s to settle
  await page.screenshot({ path: `${OUT}${name}.png` });
  taken.push(name);
  console.log("shot", name);
}
const buttons = () =>
  page.$$eval("button", (all) => all.filter((b) => !b.hidden).map((b) => b.textContent.trim() || b.getAttribute("aria-label") || ""));
async function click(text) {
  const handle = await page.evaluateHandle(
    (t) =>
      [...document.querySelectorAll("button")].find(
        (b) => !b.hidden && (b.textContent.trim() === t || (b.textContent.trim() === "" && b.getAttribute("aria-label") === t)),
      ) ?? null,
    text,
  );
  const element = handle.asElement();
  if (!element) throw new Error(`no control "${text}"; the screen has: ${(await buttons()).join(" | ")}`);
  await element.click();
}
async function until(text, timeout = 30_000) {
  await page.waitForFunction(
    (t) =>
      [...document.querySelectorAll("button")].some(
        (b) => !b.hidden && (b.textContent.trim() === t || (b.textContent.trim() === "" && b.getAttribute("aria-label") === t)),
      ),
    { timeout },
    text,
  );
}
async function untilStatus(pattern, timeout = 90_000) {
  await page.waitForFunction((src) => new RegExp(src).test(document.getElementById("status").textContent), { timeout }, pattern);
}
async function type(selector, text) {
  await page.focus(selector);
  await page.$eval(selector, (el) => el.select());
  await page.keyboard.press("Backspace");
  await page.type(selector, text);
}

try {
// First run, before any key exists.
await page.goto(PAGE, { waitUntil: "networkidle0" });
await until("Create key");
await shot("00-setup");

// The demo wallet: it asks for the password first.
await page.evaluateOnNewDocument((s) => localStorage.setItem("wallet", JSON.stringify(s)), seed);
await page.goto(PAGE, { waitUntil: "networkidle0" });
await until("Unlock");
await shot("01-unlock");
await type("input[type=password]", password);
await click("Unlock");
await until("Send");
await shot("02-home");

await click("Send");
await until("Review");
await shot("03-send");
await type('input[placeholder="qb1…"]', "qb1typo");
await type("input[inputmode=decimal]", "abc");
await shot("04-send-wrong");
await type('input[placeholder="qb1…"]', stranger.address);
await type("input[inputmode=decimal]", "1,000");
await shot("05-send-stranger");
await click("Review");
await until("Send it");
await shot("06-review-stranger");
await click("Back");
await until("Review");

await type('input[placeholder="qb1…"]', friend.address);
await click("Max");
await shot("07-send-max");
await type("input[inputmode=decimal]", "1");
await click("Review");
await until("Send it");
await shot("08-review");
if (send) {
  await click("Send it");
  await untilStatus("Done|no block", 120_000);
  await until("Send");
  await shot("09-home-after");
} else {
  await click("Back");
  await until("Review");
  await click("Back");
  await until("Send");
}

await click("Activity");
await until("Back");
await shot("10-activity");
if (await page.$("[data-row]")) {
  await page.click("[data-row]");
  await page.waitForSelector("dl");
  await shot("11-activity-detail");
}
await click("Back");
await until("Send");

await click("Receive");
await until("Copy the address");
await shot("12-receive");
await click("Back");
await until("Send");

// Tokens: add one by its address, send it. `contracts.txt` says where the demo chain has them.
const tokenAddress = readFileSync(`${DEMO}/contracts.txt`, "utf8").match(/^qusd (\S+)/m)?.[1];
if (tokenAddress) {
  await click("Tokens");
  await until("Hide");
  await shot("12a-tokens-found");
  await type('input[placeholder="qb1…"]', friend.address);
  await click("Add token");
  await untilStatus("no token");
  await shot("12b-tokens-not-a-token");
  await page.click("[data-row]");
  await until("Review");
  await shot("12d-send-token");
  await type('input[placeholder="qb1…"]', friend.address);
  await type("input[inputmode=decimal]", "99999999");
  await shot("12e-send-token-too-much");
  await type("input[inputmode=decimal]", "1.5");
  await shot("12f-send-token-amount");
  await click("Review");
  await until("Send it");
  await shot("12g-review-token");
  if (send) {
    await click("Send it");
    await untilStatus("Done|no block|did not go through", 120_000);
    await until("Send");
    await shot("12h-home-token");
    await click("Activity");
    await until("Back");
    await shot("12i-activity-token");
    await page.click("[data-row]");
    await page.waitForSelector("dl");
    await shot("12j-activity-token-detail");
    await click("Back");
    await until("Send");
  } else {
    await click("Back");
    await until("Review");
    await click("Back");
    await until("Send");
  }
}

await click("Settings");
await until("Save the node");
await shot("13-settings");
await click(`Remove Main from this browser`);
await until("Remove it for good");
await shot("14-settings-remove");
await click("Keep it");
await click("Back");
await until("Send");

await page.click("#who");
await until("Create a new key");
await shot("15-accounts");
await click("Create a new key");
await until("Create key");
await shot("16-another-key");
await click("Back");
await until("Create a new key");

// An account nothing has reached yet: locked, since only Main was unlocked.
await page.click("[data-row]");
await until("Unlock");
await shot("17-unlock-other");
await type("input[type=password]", password);
await click("Unlock");
await until("Send");
await shot("18-home-empty");
await click("Send");
await until("Receive");
await shot("19-send-empty");

} catch (error) {
  // Say what the wallet was saying, and keep a picture of it.
  const status = await page.$eval("#status", (e) => e.textContent).catch(() => "?");
  await page.screenshot({ path: `${OUT}zz-failure.png` }).catch(() => {});
  console.error(`failed: ${error.message}\nstatus line: ${status}\ncontrols: ${(await buttons().catch(() => [])).join(" | ")}`);
  process.exitCode = 1;
}
await browser.close();
console.log(`${taken.length} screens in ${OUT}`);
