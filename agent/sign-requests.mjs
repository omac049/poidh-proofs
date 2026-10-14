#!/usr/bin/env node
// poidh signer: run only by the GitHub workflow that holds the agent wallet key and the X keys.
// Withdraws any winnings, sends the New Eden posts agents filed, submits each claim request
// agents filed in a folder, and publishes the X posts agents drafted, at most once per bounty.
//
//   node sign-requests.mjs <requests folder> [<posts folder>] [<neweden folder>]
//
// Agents can write to all three folders, so their files are data and nothing more: each field is
// checked here and handed to claim.mjs or neweden.mjs as a single argument (never through a
// shell), and each script runs all of its own checks before it signs anything.
// SIGNER_CHAINS (default "base") lists the chains claims may use; POST_CHAINS (default
// "base,mainnet") the chains a post-only draft may name. SIGNER_DRY_RUN=true runs everything
// without sending. Posting needs the four X_* keys and POST_RECORDS_DIR, a folder the workflow
// keeps between runs so a bounty is never posted about twice. New Eden requests are on only when
// the third folder is given; NEWEDEN_CHAINS (default "mainnet") lists the chains they may use, and
// each one is recorded in POST_RECORDS_DIR as neweden-<number>.json so it is never sent twice.

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, lstatSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { xKeys, xSecretValues, postWeight, uploadImage, createPost, whoAmI, XError, MAX_POST_WEIGHT } from './x.mjs';

const CHAINS = (process.env.SIGNER_CHAINS || 'base').split(',').map((c) => c.trim()).filter(Boolean);
const POST_CHAINS = (process.env.POST_CHAINS || 'base,mainnet').split(',').map((c) => c.trim()).filter(Boolean);
const NEWEDEN_CHAINS = (process.env.NEWEDEN_CHAINS || 'mainnet').split(',').map((c) => c.trim()).filter(Boolean);
const DRY_RUN = process.env.SIGNER_DRY_RUN === 'true';
const RECORDS = process.env.POST_RECORDS_DIR || '';
const MAX_FILES = 10;          // per folder per run; claim.mjs also caps claims at 5 a day, counted onchain
const MAX_FILE_BYTES = 8192;
const MAX_PROOF_URI = 1000;
const MAX_POSTS_PER_DAY = 3;   // rolling 24 hours, counted from the post records
const MAX_MENTIONS = 3;
const MAX_MEDIA_BYTES = 5 * 1024 * 1024;
const MAX_NEWEDEN_PER_DAY = 6; // rolling 24 hours, counted from the New Eden records; neweden.mjs also counts posts onchain
// Post images must be pictures agents pushed to poidh-proofs, pinned to a commit.
const MEDIA_ROOT = process.env.POST_MEDIA_ROOT || 'https://raw.githubusercontent.com/omac049/poidh-proofs/';
const MEDIA_TYPES = { 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/jpeg': [0xff, 0xd8, 0xff], 'image/gif': [0x47, 0x49, 0x46, 0x38], 'image/webp': [0x52, 0x49, 0x46, 0x46] };
const FIELDS = ['chain', 'bounty', 'title', 'description', 'proof_uri'];
const POST_LINK = (url) => `\n\nPost on X: ${url}`;
const LONGEST_POST_URL = 'https://x.com/i/status/99999999999999999999';
const CLAIM = join(dirname(fileURLToPath(import.meta.url)), 'claim.mjs');
const NEWEDEN = join(dirname(fileURLToPath(import.meta.url)), 'neweden.mjs');
const NEWEDEN_NAME = /^neweden-([1-9][0-9]{0,8})\.json$/;

// Text from requests and bounties must not be read as GitHub workflow commands.
if (process.env.GITHUB_ACTIONS === 'true') console.log(`::stop-commands::${randomBytes(16).toString('hex')}`);

const SECRETS = [(process.env.POIDH_AGENT_KEY || '').trim().replace(/^0x/i, ''), ...xSecretValues()].filter((s) => s.length >= 8);
const scrub = (s) => SECRETS.reduce((t, k) => t.split(k).join('[redacted]'), String(s));
const summary = [];
const note = (line) => { line = scrub(line); console.log(line); summary.push(line.replace(/[`\r\n]/g, ' ')); };

// claim.mjs and neweden.mjs never need the X keys, so they stay out of their environment.
const CLAIM_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('X_')));

function runClaimJs(args, { dryRun = DRY_RUN, script = CLAIM } = {}) {
  const r = spawnSync(process.execPath, [script, ...args, ...(dryRun ? ['--dry-run'] : [])],
    { encoding: 'utf8', timeout: 300_000, maxBuffer: 1 << 20, env: CLAIM_ENV });
  const out = (r.stdout || '').split('\n').filter(Boolean);
  for (const line of out.slice(0, -1)) console.log(scrub(`    ${line}`));
  const last = out.at(-1) || '';
  let result = null;
  if (last.startsWith('RESULT ')) { try { result = JSON.parse(last.slice(7)); } catch { /* reported below */ } }
  const name = script === CLAIM ? 'claim.mjs' : 'neweden.mjs';
  if (!result) result = { ok: false, error: r.error?.code === 'ETIMEDOUT' ? `${name} timed out` : `${name} exited ${r.status} without a result` };
  return { code: r.status, result };
}

// Reads one request file as a plain object with only the allowed keys, or throws with a reason
// that never quotes the file.
function readJsonFile(dir, name, allowed, required) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}\.json$/.test(name)) throw new Error('file name must be lowercase letters, digits and dashes, ending in .json');
  const path = join(dir, name);
  const st = lstatSync(path);
  if (!st.isFile()) throw new Error('not a regular file');
  if (st.size > MAX_FILE_BYTES) throw new Error(`larger than ${MAX_FILE_BYTES} bytes`);
  let req;
  try { req = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error('not valid JSON'); }
  if (!req || typeof req !== 'object' || Array.isArray(req)) throw new Error('not a JSON object');
  const extra = Object.keys(req).filter((k) => !allowed.includes(k));
  if (extra.length) throw new Error(`unknown field(s) ${extra.slice(0, 5).map((k) => JSON.stringify(k.slice(0, 30))).join(', ')}`);
  for (const k of required) if (!(k in req)) throw new Error(`missing field "${k}"`);
  return req;
}

function readBounty(req, chains) {
  const bounty = typeof req.bounty === 'number' ? String(req.bounty) : req.bounty;
  if (!chains.includes(req.chain)) throw new Error(`chain must be one of ${chains.join(', ')}`);
  if (typeof bounty !== 'string' || !/^[1-9][0-9]{0,8}$/.test(bounty)) throw new Error('bounty must be the bounty number from its poidh link');
  return { chain: req.chain, bounty };
}

function readPost(post) {
  if (!post || typeof post !== 'object' || Array.isArray(post)) throw new Error('"post" must be an object');
  const extra = Object.keys(post).filter((k) => !['text', 'media_uri'].includes(k));
  if (extra.length) throw new Error(`unknown post field(s) ${extra.slice(0, 5).map((k) => JSON.stringify(k.slice(0, 30))).join(', ')}`);
  const text = typeof post.text === 'string' ? post.text.trim() : '';
  if (!text) throw new Error('"post.text" must be a non-empty string');
  if (/[\u0000-\u0009\u000b-\u001f\u007f‪-‮⁦-⁩]/.test(text)) throw new Error('post text contains control characters');
  const weight = postWeight(text);
  if (weight > MAX_POST_WEIGHT) throw new Error(`post text counts ${weight} of X's ${MAX_POST_WEIGHT} characters`);
  const mentions = (text.match(/(^|[^\w@])@\w{1,15}/g) || []).length;
  if (mentions > MAX_MENTIONS) throw new Error(`post text mentions ${mentions} accounts; the limit is ${MAX_MENTIONS}`);
  const media = post.media_uri;
  if (media !== undefined) {
    const rest = typeof media === 'string' && media.startsWith(MEDIA_ROOT) ? media.slice(MEDIA_ROOT.length) : '';
    if (!/^[0-9a-f]{40}\/proofs\/[a-z0-9-]{1,64}\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/.test(rest)) {
      throw new Error(`"post.media_uri" must be ${MEDIA_ROOT}<full commit sha>/proofs/<folder>/<file>`);
    }
  }
  return { text, media };
}

// Returns the claim.mjs arguments for one claim request, plus its post draft if it has one.
function readRequest(dir, name) {
  const req = readJsonFile(dir, name, [...FIELDS, 'post'], FIELDS);
  const { chain, bounty } = readBounty(req, CHAINS);
  const { title, description, proof_uri: proof } = req;
  for (const [k, v] of [['title', title], ['description', description], ['proof_uri', proof]]) {
    if (typeof v !== 'string' || !v.trim()) throw new Error(`"${k}" must be a non-empty string`);
  }
  if (/[\u0000-\u001f\u007f]/.test(title) || /[\u0000- \u007f]/.test(proof)) throw new Error('title or proof_uri contains control characters or spaces');
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(description)) throw new Error('description contains control characters');
  if (proof.length > MAX_PROOF_URI) throw new Error(`proof_uri is longer than ${MAX_PROOF_URI} characters`);
  const post = 'post' in req ? readPost(req.post) : null;
  // "--name=value" keeps a value that starts with "-" from being read as an option.
  const args = (desc) => [`--chain=${chain}`, `--bounty=${bounty}`, `--title=${title}`, `--description=${desc}`, `--proof-uri=${proof}`];
  return { chain, bounty, description: description.trim(), args, post };
}

function readPostDraft(dir, name) {
  const req = readJsonFile(dir, name, ['chain', 'bounty', 'post'], ['chain', 'bounty', 'post']);
  return { ...readBounty(req, POST_CHAINS), post: readPost(req.post) };
}

// Returns the neweden.mjs arguments for one New Eden request: a post in a room, or the wallet's profile.
function readNewEden(dir, name) {
  if (!NEWEDEN_NAME.test(name)) throw new Error('file name must be neweden-<number>.json');
  const req = readJsonFile(dir, name, ['chain', 'action', 'room', 'text', 'name', 'description'], ['chain', 'action']);
  if (!NEWEDEN_CHAINS.includes(req.chain)) throw new Error(`chain must be one of ${NEWEDEN_CHAINS.join(', ')}`);
  const fields = { post: ['room', 'text'], register: ['name', 'description'] }[req.action];
  if (!fields) throw new Error('"action" must be "post" or "register"');
  const extra = Object.keys(req).filter((k) => !['chain', 'action', ...fields].includes(k));
  if (extra.length) throw new Error(`a ${req.action} request does not take ${extra.map((k) => `"${k}"`).join(', ')}`);
  for (const k of fields) {
    if (k === 'room') {
      if (!Number.isInteger(req.room) || req.room < 0 || req.room > 999_999_999) throw new Error('"room" must be a room number, such as 6');
    } else {
      if (typeof req[k] !== 'string' || !req[k].trim()) throw new Error(`"${k}" must be a non-empty string`);
      if (/[\u0000-\u0009\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(req[k])) throw new Error(`"${k}" contains control characters`);
    }
  }
  const args = req.action === 'post'
    ? ['post', `--chain=${req.chain}`, `--room=${req.room}`, `--text=${req.text.trim()}`]
    : ['register', `--chain=${req.chain}`, `--name=${req.name.trim()}`, `--description=${req.description.trim()}`];
  return { key: name.slice(0, -5), action: req.action, chain: req.chain, args };
}

// ---- Post records: one per bounty, so nothing is ever posted twice ----
const records = new Map();
function loadRecords() {
  if (!RECORDS) return;
  let names = [];
  try { names = readdirSync(RECORDS); } catch { return; }
  for (const n of names) {
    if (!/^[a-z]+-[1-9][0-9]{0,8}\.json$/.test(n)) continue;
    try {
      const r = JSON.parse(readFileSync(join(RECORDS, n), 'utf8'));
      if (typeof r.url === 'string' && /^https:\/\/x\.com\/i\/status\/\d{1,30}$/.test(r.url) && Number.isFinite(r.postedAt)) records.set(n.slice(0, -5), r);
    } catch { /* ignore unreadable records */ }
  }
}

// New Eden records are their own shape, so they never count toward the X post cap.
const edenRecords = new Map();
function loadNewEdenRecords() {
  if (!RECORDS) return;
  let names = [];
  try { names = readdirSync(RECORDS); } catch { return; }
  for (const n of names) {
    if (!NEWEDEN_NAME.test(n)) continue;
    try {
      const r = JSON.parse(readFileSync(join(RECORDS, n), 'utf8'));
      if (typeof r.tx === 'string' && /^0x[0-9a-f]{64}$/.test(r.tx) && Number.isFinite(r.sentAt)) edenRecords.set(n.slice(0, -5), r);
    } catch { /* ignore unreadable records */ }
  }
}

async function fetchMedia(uri) {
  let res;
  try { res = await fetch(uri, { redirect: 'error', signal: AbortSignal.timeout(30_000) }); }
  catch (e) { throw new Error(`could not fetch the post image (${e.cause?.code || e.name})`); }
  if (!res.ok) throw new Error(`the post image returned HTTP ${res.status}`);
  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!MEDIA_TYPES[type]) { await res.body?.cancel(); throw new Error(`the post image is "${type || 'unknown'}", not PNG, JPEG, GIF or WebP`); }
  if (Number(res.headers.get('content-length') || 0) > MAX_MEDIA_BYTES) { await res.body?.cancel(); throw new Error('the post image is larger than 5 MB'); }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_MEDIA_BYTES) throw new Error('the post image is larger than 5 MB');
  if (!MEDIA_TYPES[type].every((b, i) => bytes[i] === b)) throw new Error(`the post image is not really ${type}`);
  return { bytes, type };
}

// Publishes a draft once and records it. Returns the post's link, or null with the reason noted.
async function publish(label, key, post) {
  if (records.has(key)) return records.get(key).url;
  if (!RECORDS) { note(`${label}: skipped, posting needs POST_RECORDS_DIR`); return null; }
  const keys = xKeys();
  if (!keys) { note(`${label}: skipped, posting to X is not set up (X keys missing)`); return null; }
  const now = Math.floor(Date.now() / 1000);
  const recent = [...records.values()].filter((r) => now - r.postedAt < 86_400).length;
  if (recent >= MAX_POSTS_PER_DAY) { note(`${label}: waiting, the daily post cap is reached (${recent} of ${MAX_POSTS_PER_DAY} in 24 hours)`); return null; }
  let media = null;
  if (post.media) {
    try { media = await fetchMedia(post.media); } catch (e) { note(`${label}: refused, ${e.message}`); return null; }
  }
  if (DRY_RUN) { note(`${label}: dry run, would post ${postWeight(post.text)} characters${media ? ' with an image' : ''}`); return null; }
  try {
    const mediaId = media ? await uploadImage(keys, media.bytes, media.type) : undefined;
    const { id, url } = await createPost(keys, post.text, mediaId);
    const [chain, bounty] = key.split('-');
    const rec = { chain, bounty, id, url, postedAt: now };
    records.set(key, rec);
    try { writeFileSync(join(RECORDS, `${key}.json`), `${JSON.stringify(rec)}\n`); }
    catch (e) { note(`${label}: posted ${url} but could not record it (${e.code || e.message})`); failed = true; }
    note(`${label}: posted ${url}`);
    return url;
  } catch (e) {
    note(`${label}: ${e instanceof XError ? e.message : `error while posting, ${e.message}`}`);
    failed = true;
    return null;
  }
}

function listFiles(dir, order) {
  if (!dir) return [];
  let names;
  try { names = readdirSync(dir, { withFileTypes: true }).filter((d) => !d.isDirectory()).map((d) => d.name).sort(order); }
  catch { note(`no folder ${dir.split('/').at(-1)}`); return []; }
  if (names.length > MAX_FILES) note(`${names.length} files in ${dir.split('/').at(-1)}; handling the first ${MAX_FILES} this run`);
  return names.slice(0, MAX_FILES);
}

const safeLabel = (name) => (/^[\w.-]{1,80}$/.test(name) ? name : '(file with an unusual name)');

let failed = false;
note(`poidh signer${DRY_RUN ? ' (dry run)' : ''}`);
loadRecords();
loadNewEdenRecords();

// Say whether posting is on. A dry run also asks X which account the keys post as.
const X_KEYS = xKeys();
if (!X_KEYS) note('posting to X: off, X keys missing');
else if (!RECORDS) note('posting to X: off, no POST_RECORDS_DIR');
else if (!DRY_RUN) note('posting to X: on');
else {
  try { note(`posting to X: on, as @${await whoAmI(X_KEYS)}`); }
  catch (e) { note(`posting to X: ${e instanceof XError ? e.message : `error, ${e.message}`}`); failed = true; }
}

for (const chain of CHAINS) {
  const { code, result } = runClaimJs(['withdraw', `--chain=${chain}`]);
  if (result.ok) note(`withdraw on ${chain}: ${result.dryRun ? `would withdraw ${result.amount} ETH` : `${result.amount} ETH, ${result.link}`}`);
  else if (code === 2 && /Nothing to withdraw/.test(result.error)) note(`withdraw on ${chain}: nothing waiting`);
  else { note(`withdraw on ${chain}: ${result.error}`); if (code !== 2) failed = true; }
}

const [requestsDir, postsDir, edenDir] = process.argv.slice(2);

// New Eden requests, sent before claims so a claim filed in the same run can point at them.
// Numbered files run in number order, so a register request can come before the posts that need it.
if (!edenDir) note('New Eden: off, no neweden folder given');
else if (!RECORDS) note('New Eden: off, no POST_RECORDS_DIR to record what was sent');
else {
  note(`New Eden: on (${NEWEDEN_CHAINS.join(', ')})`);
  const num = (n) => Number(NEWEDEN_NAME.exec(n)?.[1] ?? Infinity);
  for (const name of listFiles(edenDir, (a, b) => num(a) - num(b) || (a < b ? -1 : 1))) {
    const label = `neweden/${safeLabel(name)}`;
    let act;
    try { act = readNewEden(edenDir, name); }
    catch (e) { note(`${label}: skipped, ${e.message}`); continue; }
    if (edenRecords.has(act.key)) { note(`${label}: already done, ${edenRecords.get(act.key).link}`); continue; }
    const now = Math.floor(Date.now() / 1000);
    const recent = [...edenRecords.values()].filter((r) => now - r.sentAt < 86_400).length;
    if (recent >= MAX_NEWEDEN_PER_DAY) { note(`${label}: waiting, the daily New Eden cap is reached (${recent} of ${MAX_NEWEDEN_PER_DAY} in 24 hours)`); continue; }
    const { code, result } = runClaimJs(act.args, { script: NEWEDEN });
    if (result.ok && result.dryRun) { note(`${label}: dry run passed`); continue; }
    if (!result.ok) { note(`${label}: ${code === 2 ? 'refused' : 'error'}, ${result.error}`); if (code !== 2) failed = true; continue; }
    // A post found already onchain is recorded too, but does not count toward today's cap.
    const rec = { action: act.action, chain: act.chain, tx: result.tx, link: result.link, sentAt: result.already ? 0 : now };
    edenRecords.set(act.key, rec);
    try { writeFileSync(join(RECORDS, `${act.key}.json`), `${JSON.stringify(rec)}\n`); }
    catch (e) { note(`${label}: sent ${result.link} but could not record it (${e.code || e.message})`); failed = true; }
    note(`${label}: ${result.already ? 'already posted' : act.action === 'post' ? 'posted' : 'registered'}, ${result.link}`);
  }
}

for (const name of listFiles(requestsDir)) {
  const label = safeLabel(name);
  let req;
  try { req = readRequest(requestsDir, name); }
  catch (e) { note(`${label}: skipped, ${e.message}`); continue; }
  let description = req.description;
  if (req.post) {
    // Check the claim would go through, with room for the post link, before posting anything.
    const pre = runClaimJs(['claim', ...req.args(description + POST_LINK(LONGEST_POST_URL))], { dryRun: true });
    if (!pre.result.ok) {
      if (pre.code === 2 && /already claimed this bounty/.test(pre.result.error)) note(`${label}: already claimed`);
      else { note(`${label}: ${pre.code === 2 ? 'refused' : 'error'}, ${pre.result.error}`); if (pre.code !== 2) failed = true; }
      continue;
    }
    const url = await publish(label, `${req.chain}-${req.bounty}`, req.post);
    if (!url) { if (DRY_RUN) note(`${label}: dry run passed`); continue; }
    description += POST_LINK(url);
  }
  const { code, result } = runClaimJs(['claim', ...req.args(description)]);
  if (result.ok && result.dryRun) note(`${label}: dry run passed`);
  else if (result.ok) note(`${label}: claimed, claim ${result.claimId}, ${result.link}`);
  else if (code === 2 && /already claimed this bounty/.test(result.error)) note(`${label}: already claimed`);
  else { note(`${label}: ${code === 2 ? 'refused' : 'error'}, ${result.error}`); if (code !== 2) failed = true; }
}

// Post-only drafts, for bounties the agent claims some other way. The bounty must be open.
for (const name of listFiles(postsDir)) {
  const label = `posts/${safeLabel(name)}`;
  let draft;
  try { draft = readPostDraft(postsDir, name); }
  catch (e) { note(`${label}: skipped, ${e.message}`); continue; }
  const key = `${draft.chain}-${draft.bounty}`;
  if (records.has(key)) { note(`${label}: already posted, ${records.get(key).url}`); continue; }
  const { code, result } = runClaimJs(['check', `--chain=${draft.chain}`, `--bounty=${draft.bounty}`], { dryRun: false });
  if (!result.ok) { note(`${label}: ${code === 2 ? 'refused' : 'error'}, ${result.error}`); if (code !== 2) failed = true; continue; }
  const blockers = (result.problems || []).filter((p) => !/^the daily cap is reached/.test(p));
  if (blockers.length) { note(`${label}: skipped, ${blockers.join('; ')}`); continue; }
  await publish(label, key, draft.post);
}

if (process.env.GITHUB_STEP_SUMMARY) {
  try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\`\`\`text\n${summary.join('\n')}\n\`\`\`\n`); } catch { /* summary is optional */ }
}
process.exit(failed ? 1 : 0);
