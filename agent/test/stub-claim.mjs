#!/usr/bin/env node
// Stand-in for claim.mjs in test-post.sh: answers like claim.mjs without a chain, and logs each
// call (with whether any X key reached its environment) to $STUB_LOG.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const [cmd, ...rest] = process.argv.slice(2);
const opts = Object.fromEntries(rest.map((a) => { const m = a.match(/^--([^=]+)(?:=([\s\S]*))?$/); return [m[1], m[2] ?? true]; }));
const state = (() => { try { return JSON.parse(readFileSync(process.env.STUB_STATE, 'utf8')); } catch { return { claimed: [] }; } })();
appendFileSync(process.env.STUB_LOG, `${JSON.stringify({ cmd, opts, xKeyInEnv: Object.keys(process.env).some((k) => k.startsWith('X_')) })}\n`);
const out = (code, r) => { console.log(`RESULT ${JSON.stringify(r)}`); process.exit(code); };
if (cmd === 'withdraw') out(2, { ok: false, error: 'Refused: Nothing to withdraw.' });
if (cmd === 'check') {
  if (opts.bounty === '404') out(0, { ok: true, claimable: false, problems: ['the bounty is closed or cancelled'] });
  if (opts.bounty === '505') out(0, { ok: true, claimable: false, problems: ['the daily cap is reached (5 of 5 claims in the last 24 hours)'] });
  out(0, { ok: true, claimable: true, problems: [] });
}
if (cmd === 'claim') {
  if (opts.bounty === '303') out(2, { ok: false, error: 'Refused: Proof URI returned HTTP 404.' });
  if (state.claimed.includes(opts.bounty)) out(2, { ok: false, error: `Refused: Bounty ${opts.bounty} is not claimable: the agent wallet already claimed this bounty (claim 1).` });
  if (opts['dry-run']) out(0, { ok: true, dryRun: true });
  state.claimed.push(opts.bounty); writeFileSync(process.env.STUB_STATE, JSON.stringify(state));
  out(0, { ok: true, claimId: String(state.claimed.length), link: `local tx 0x${state.claimed.length}` });
}
out(2, { ok: false, error: 'Refused: unknown command' });
