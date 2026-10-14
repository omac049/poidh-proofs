#!/usr/bin/env node
// poidh signer: run only by the GitHub workflow that holds the agent wallet key.
// Withdraws any winnings, then submits each claim request agents filed in a folder.
//
//   node sign-requests.mjs <requests folder>
//
// Agents can write to the requests folder, so its files are data and nothing more: each
// field is checked here and handed to claim.mjs as a single argument (never through a
// shell), and claim.mjs runs all of its own checks before it signs anything.
// SIGNER_CHAINS (default "base") lists the chains requests may use; SIGNER_DRY_RUN=true
// runs everything without sending.

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, lstatSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const CHAINS = (process.env.SIGNER_CHAINS || 'base').split(',').map((c) => c.trim()).filter(Boolean);
const DRY_RUN = process.env.SIGNER_DRY_RUN === 'true';
const MAX_FILES = 10;          // per run; claim.mjs also caps claims at 5 a day, counted onchain
const MAX_FILE_BYTES = 8192;
const MAX_PROOF_URI = 1000;
const FIELDS = ['chain', 'bounty', 'title', 'description', 'proof_uri'];
const CLAIM = join(dirname(fileURLToPath(import.meta.url)), 'claim.mjs');

// Text from requests and bounties must not be read as GitHub workflow commands.
if (process.env.GITHUB_ACTIONS === 'true') console.log(`::stop-commands::${randomBytes(16).toString('hex')}`);

const summary = [];
const note = (line) => { console.log(line); summary.push(line.replace(/[`\r\n]/g, ' ')); };

function runClaimJs(args) {
  const r = spawnSync(process.execPath, [CLAIM, ...args, ...(DRY_RUN ? ['--dry-run'] : [])],
    { encoding: 'utf8', timeout: 300_000, maxBuffer: 1 << 20 });
  const out = (r.stdout || '').split('\n').filter(Boolean);
  for (const line of out.slice(0, -1)) console.log(`    ${line}`);
  const last = out.at(-1) || '';
  let result = null;
  if (last.startsWith('RESULT ')) { try { result = JSON.parse(last.slice(7)); } catch { /* reported below */ } }
  if (!result) result = { ok: false, error: r.error?.code === 'ETIMEDOUT' ? 'claim.mjs timed out' : `claim.mjs exited ${r.status} without a result` };
  return { code: r.status, result };
}

// Returns the claim.mjs arguments for one request file, or throws with a reason that never quotes the file.
function readRequest(dir, name) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}\.json$/.test(name)) throw new Error('file name must be lowercase letters, digits and dashes, ending in .json');
  const path = join(dir, name);
  const st = lstatSync(path);
  if (!st.isFile()) throw new Error('not a regular file');
  if (st.size > MAX_FILE_BYTES) throw new Error(`larger than ${MAX_FILE_BYTES} bytes`);
  let req;
  try { req = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error('not valid JSON'); }
  if (!req || typeof req !== 'object' || Array.isArray(req)) throw new Error('not a JSON object');
  const keys = Object.keys(req);
  const extra = keys.filter((k) => !FIELDS.includes(k));
  if (extra.length) throw new Error(`unknown field(s) ${extra.slice(0, 5).map((k) => JSON.stringify(k.slice(0, 30))).join(', ')}`);
  for (const k of FIELDS) if (!(k in req)) throw new Error(`missing field "${k}"`);
  const { chain, title, description, proof_uri: proof } = req;
  const bounty = typeof req.bounty === 'number' ? String(req.bounty) : req.bounty;
  if (!CHAINS.includes(chain)) throw new Error(`chain must be one of ${CHAINS.join(', ')}`);
  if (typeof bounty !== 'string' || !/^[1-9][0-9]{0,8}$/.test(bounty)) throw new Error('bounty must be the bounty number from its poidh link');
  for (const [k, v] of [['title', title], ['description', description], ['proof_uri', proof]]) {
    if (typeof v !== 'string' || !v.trim()) throw new Error(`"${k}" must be a non-empty string`);
  }
  if (/[\u0000-\u001f\u007f]/.test(title) || /[\u0000- \u007f]/.test(proof)) throw new Error('title or proof_uri contains control characters or spaces');
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(description)) throw new Error('description contains control characters');
  if (proof.length > MAX_PROOF_URI) throw new Error(`proof_uri is longer than ${MAX_PROOF_URI} characters`);
  // "--name=value" keeps a value that starts with "-" from being read as an option.
  return [`--chain=${chain}`, `--bounty=${bounty}`, `--title=${title}`, `--description=${description}`, `--proof-uri=${proof}`];
}

let failed = false;
note(`poidh signer${DRY_RUN ? ' (dry run)' : ''}`);

for (const chain of CHAINS) {
  const { code, result } = runClaimJs(['withdraw', `--chain=${chain}`]);
  if (result.ok) note(`withdraw on ${chain}: ${result.dryRun ? `would withdraw ${result.amount} ETH` : `${result.amount} ETH, ${result.link}`}`);
  else if (code === 2 && /Nothing to withdraw/.test(result.error)) note(`withdraw on ${chain}: nothing waiting`);
  else { note(`withdraw on ${chain}: ${result.error}`); if (code !== 2) failed = true; }
}

const dir = process.argv[2];
let names = [];
try { names = readdirSync(dir, { withFileTypes: true }).filter((d) => !d.isDirectory()).map((d) => d.name).sort(); }
catch { note('no requests folder'); }
if (names.length > MAX_FILES) note(`${names.length} request files; handling the first ${MAX_FILES} this run`);

for (const name of names.slice(0, MAX_FILES)) {
  const label = /^[\w.-]{1,80}$/.test(name) ? name : '(file with an unusual name)';
  let args;
  try { args = readRequest(dir, name); }
  catch (e) { note(`${label}: skipped, ${e.message}`); continue; }
  const { code, result } = runClaimJs(['claim', ...args]);
  if (result.ok && result.dryRun) note(`${label}: dry run passed`);
  else if (result.ok) note(`${label}: claimed, claim ${result.claimId}, ${result.link}`);
  else if (code === 2 && /already claimed this bounty/.test(result.error)) note(`${label}: already claimed`);
  else { note(`${label}: ${code === 2 ? 'refused' : 'error'}, ${result.error}`); if (code !== 2) failed = true; }
}

if (process.env.GITHUB_STEP_SUMMARY) {
  try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\`\`\`text\n${summary.join('\n')}\n\`\`\`\n`); } catch { /* summary is optional */ }
}
process.exit(failed ? 1 : 0);
