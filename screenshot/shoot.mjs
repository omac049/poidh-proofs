#!/usr/bin/env node
// Takes proof screenshots of public pages, on GitHub's machines.
// Reads shots/*.json, saves each picture under proofs/, and moves the request to shots/done/
// (or to shots/failed/ with a picture of what the page showed and the reason).
// It holds no keys, connects no wallet and only opens https pages on the hosts below.
//
//   node screenshot/shoot.mjs <repo root>
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ROOT = process.argv[2] || '.';
const SHOTS = join(ROOT, 'shots');
const HOSTS = ['neweden.wei.limo', 'poidh.xyz', 'etherscan.io', 'basescan.org', 'arbiscan.io'];
// Test runs only: also allow plain http on this host (a local file server).
const TEST_HOST = process.env.SHOTS_TEST_HOST || '';
const MAX_FILES = 5;
const MAX_BYTES = 5 * 1024 * 1024; // X's image limit, so a shot can also be a post's picture
const NAME = /^[a-z0-9][a-z0-9-]{0,63}\.json$/;
const OUT = /^proofs\/[a-z0-9-]{1,64}\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}\.png$/;
const FIELDS = ['url', 'out', 'wait_ms', 'click', 'scroll_to', 'full_page'];
const PHONE = { width: 430, height: 932 };

const summary = [];
const note = (s) => { summary.push(s); console.log(s); };
const text = (v, n, what) => {
  if (typeof v !== 'string' || !v.trim() || v.length > n || /[\u0000-\u001f\u007f]/.test(v)) {
    throw new Error(`${what} must be a non-empty string of at most ${n} characters`);
  }
  return v.trim();
};

function readShot(name) {
  let req;
  try { req = JSON.parse(readFileSync(join(SHOTS, name), 'utf8')); }
  catch { throw new Error('not valid JSON'); }
  if (!req || typeof req !== 'object' || Array.isArray(req)) throw new Error('must be a JSON object');
  const extra = Object.keys(req).filter((k) => !FIELDS.includes(k));
  if (extra.length) throw new Error(`unknown field(s) ${extra.slice(0, 5).map((k) => JSON.stringify(k.slice(0, 30))).join(', ')}`);

  let url;
  try { url = new URL(text(req.url, 500, '"url"')); }
  catch (e) { throw new Error(e.message.startsWith('"url"') ? e.message : '"url" must be a full URL'); }
  const test = TEST_HOST && url.protocol === 'http:' && url.hostname === TEST_HOST;
  if (!test && (url.protocol !== 'https:' || !HOSTS.includes(url.hostname) || url.port)) {
    throw new Error(`"url" must be an https page on ${HOSTS.join(', ')}`);
  }
  if (url.username || url.password) throw new Error('"url" must not carry a user name or password');

  const out = typeof req.out === 'string' ? req.out : '';
  if (!OUT.test(out)) throw new Error('"out" must be proofs/<folder>/<file>.png');
  if (existsSync(join(ROOT, out))) throw new Error(`${out} already exists; pick a new file name`);

  const wait = req.wait_ms ?? 8000;
  if (!Number.isInteger(wait) || wait < 0 || wait > 30_000) throw new Error('"wait_ms" must be a whole number from 0 to 30000');
  const click = req.click ?? [];
  if (!Array.isArray(click) || click.length > 5) throw new Error('"click" must be a list of at most 5 texts');
  const clicks = click.map((c, i) => text(c, 80, `"click" item ${i + 1}`));
  const scrollTo = req.scroll_to === undefined ? null : text(req.scroll_to, 80, '"scroll_to"');
  const fullPage = req.full_page ?? false;
  if (typeof fullPage !== 'boolean') throw new Error('"full_page" must be true or false');
  return { url: url.href, out, wait, clicks, scrollTo, fullPage };
}

// Clicks the on-screen element with this label that is really on top at its centre, the way a
// finger would. Pages often repeat a label in hidden or covered places (menus, map labels behind a
// panel), and a click sent to one of those does nothing.
async function clickText(page, label) {
  const found = await page.evaluate((label) => {
    const want = label.trim().toLowerCase();
    const text = (el) => (el.innerText || '').trim().toLowerCase();
    const all = [...document.querySelectorAll('body *')].filter((el) => text(el).includes(want));
    // Exact labels first, smallest first so a button wins over the bar around it; then the
    // shortest texts that contain the label.
    const area = (el) => { const r = el.getBoundingClientRect(); return r.width * r.height; };
    const ranked = [...all.filter((el) => text(el) === want).sort((x, y) => area(x) - area(y)),
      ...all.filter((el) => text(el) !== want).sort((x, y) => text(x).length - text(y).length)];
    const seen = [];
    for (const el of ranked) {
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const top = document.elementFromPoint(x, y);
      if (top && (top === el || el.contains(top) || top.contains(el))) return { x, y };
      if (seen.length < 3) seen.push(`<${el.tagName.toLowerCase()}> under <${top ? top.tagName.toLowerCase() : 'nothing'}>`);
    }
    return { matches: all.length, seen };
  }, label);
  if (found.x === undefined) {
    throw new Error(`could not click "${label}": ${found.matches} element(s) contain it, none on top${found.seen.length ? ` (${found.seen.join(', ')})` : ''}`);
  }
  await page.mouse.click(found.x, found.y);
}

async function shoot(browser, shot, failPath) {
  const context = await browser.newContext({
    viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    acceptDownloads: false, serviceWorkers: 'block',
  });
  const page = await context.newPage();
  try {
    await page.goto(shot.url, { waitUntil: 'load', timeout: 60_000 });
    await page.waitForTimeout(shot.wait);
    for (const c of shot.clicks) {
      await clickText(page, c);
      await page.waitForTimeout(2_000);
    }
    if (shot.scrollTo) {
      const target = page.getByText(shot.scrollTo, { exact: false }).locator('visible=true').last();
      await target.waitFor({ state: 'attached', timeout: 20_000 });
      await target.scrollIntoViewIfNeeded({ timeout: 10_000 });
      await page.waitForTimeout(1_000);
    }
    const bytes = await page.screenshot({ fullPage: shot.fullPage, type: 'png' });
    if (bytes.length > MAX_BYTES) throw new Error(`the picture is ${bytes.length} bytes, over ${MAX_BYTES}; drop full_page`);
    mkdirSync(dirname(join(ROOT, shot.out)), { recursive: true });
    writeFileSync(join(ROOT, shot.out), bytes, { flag: 'wx' });
  } catch (e) {
    // Keep a picture of whatever the page showed, so the next try can be fixed.
    try { writeFileSync(failPath, await page.screenshot({ type: 'png' })); } catch { /* the page may be gone */ }
    throw e;
  } finally {
    await context.close();
  }
}

const files = existsSync(SHOTS)
  ? readdirSync(SHOTS).filter((f) => f.endsWith('.json') && statSync(join(SHOTS, f)).isFile()).sort()
  : [];
for (const f of files.filter((f) => !NAME.test(f))) note(`shots/${f.slice(0, 70)}: skipped, file names are lower-case letters, digits and dashes`);
const valid = files.filter((f) => NAME.test(f));
if (!valid.length) { note('no screenshot requests'); process.exit(0); }
if (valid.length > MAX_FILES) note(`${valid.length} requests waiting; taking the first ${MAX_FILES}`);

// Test runs only: a Chromium already on the machine.
const browser = await chromium.launch(process.env.SHOTS_CHROMIUM ? { executablePath: process.env.SHOTS_CHROMIUM } : {});
let failed = false;
for (const name of valid.slice(0, MAX_FILES)) {
  const label = `shots/${name.slice(0, 70)}`;
  const move = (to) => {
    mkdirSync(join(SHOTS, to), { recursive: true });
    renameSync(join(SHOTS, name), join(SHOTS, to, name));
  };
  const base = name.replace(/\.json$/, '');
  let shot;
  try { shot = readShot(name); }
  catch (e) {
    move('failed');
    writeFileSync(join(SHOTS, 'failed', `${base}.txt`), `${e.message}\n`);
    note(`${label}: refused, ${e.message}`);
    continue;
  }
  mkdirSync(join(SHOTS, 'failed'), { recursive: true });
  try {
    await shoot(browser, shot, join(SHOTS, 'failed', `${base}.png`));
    move('done');
    note(`${label}: saved ${shot.out}`);
  } catch (e) {
    move('failed');
    const reason = String(e.message || e).split('\n')[0].slice(0, 300);
    writeFileSync(join(SHOTS, 'failed', `${base}.txt`), `${reason}\n`);
    note(`${label}: failed, ${reason}`);
    failed = true;
  }
}
await browser.close();

if (process.env.GITHUB_STEP_SUMMARY) {
  try { writeFileSync(process.env.GITHUB_STEP_SUMMARY, `\`\`\`text\n${summary.join('\n')}\n\`\`\`\n`, { flag: 'a' }); } catch { /* optional */ }
}
process.exit(failed ? 1 : 0);
