#!/usr/bin/env node
// poidh agent: submit claims and withdraw winnings from the agent wallet, and nothing else.
//
//   node claim.mjs status   --chain base [--address 0x…]   (read-only; no key needed with --address)
//   node claim.mjs check    --chain base --bounty 1484 [--address 0x…]
//   node claim.mjs claim    --chain base --bounty 1484 --title "..." --description "..." --proof-uri https://... [--dry-run]
//   node claim.mjs withdraw --chain base [--dry-run]
//
// The signing key comes only from POIDH_AGENT_KEY and is never printed.
// Every guard below runs before anything is signed; any failure stops the run.

import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import {
  createPublicClient, createWalletClient, http, parseAbi, formatEther, parseEther,
  decodeEventLog, getAddress, BaseError, ContractFunctionRevertedError, HttpRequestError,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, mainnet, arbitrum, foundry } from 'viem/chains';

// ---- Fixed limits. Changing one means editing this file, on purpose. ----
const MAX_CLAIMS_PER_DAY = 5;           // rolling 24 hours, counted onchain
const MAX_TITLE = 120;
const MAX_DESCRIPTION = 2000;

// poidh v3 only. Addresses from poidh's deployment docs and skill.md.
const CHAINS = {
  base: {
    chain: base, contract: '0x5555Fa783936C260f77385b4E153B9725feF1719',
    rpcEnv: 'RPC_URL_BASE', rpcDefault: 'https://mainnet.base.org',
    explorer: 'https://basescan.org/tx/', maxFee: parseEther('0.00005'),
  },
  arbitrum: {
    chain: arbitrum, contract: '0x5555Fa783936C260f77385b4E153B9725feF1719',
    rpcEnv: 'RPC_URL_ARBITRUM', rpcDefault: 'https://arb1.arbitrum.io/rpc',
    explorer: 'https://arbiscan.io/tx/', maxFee: parseEther('0.00005'),
  },
  mainnet: {
    chain: mainnet, contract: '0xE731dFadBFf20542E10D09D26Fc71445C70d4232',
    rpcEnv: 'RPC_URL_MAINNET', rpcDefault: 'https://ethereum-rpc.publicnode.com',
    explorer: 'https://etherscan.io/tx/', maxFee: parseEther('0.0005'),
  },
  // Test chain only: a local anvil node with a locally deployed PoidhV3.
  local: {
    chain: foundry, contract: process.env.POIDH_TEST_CONTRACT,
    rpcEnv: 'RPC_URL_LOCAL', rpcDefault: 'http://127.0.0.1:8545',
    explorer: 'local tx ', maxFee: parseEther('0.01'), test: true,
  },
};

const ABI = parseAbi([
  'function bountyCounter() view returns (uint256)',
  'function bounties(uint256) view returns (uint256 id, address issuer, string name, string description, uint256 amount, address claimer, uint256 createdAt, uint256 claimId)',
  'function claims(uint256) view returns (uint256 id, address issuer, uint256 bountyId, address bountyIssuer, string name, string description, uint256 createdAt, bool accepted)',
  'function bountyCurrentVotingClaim(uint256) view returns (uint256)',
  'function userClaims(address, uint256) view returns (uint256)',
  'function pendingWithdrawals(address) view returns (uint256)',
  'function createClaim(uint256 bountyId, string name, string description, string uri)',
  'function withdraw()',
  'event ClaimCreated(uint256 indexed id, address indexed issuer, uint256 indexed bountyId, address bountyIssuer, string title, string description, uint256 createdAt, string imageUri, uint256 round)',
  'event Withdrawal(address indexed user, uint256 amount)',
  'error NoEther()', 'error BountyNotFound()', 'error VotingOngoing()', 'error BountyClaimed()',
  'error BountyClosed()', 'error IssuerCannotClaim()', 'error NothingToWithdraw()', 'error TransferFailed()',
]);

// ---- Output that can never contain the key ----
const RAW_KEY = (process.env.POIDH_AGENT_KEY || '').trim().replace(/^0x/i, '');
function scrub(s) {
  s = String(s);
  return RAW_KEY.length >= 32 ? s.split(RAW_KEY).join('[redacted]').split(RAW_KEY.toLowerCase()).join('[redacted]') : s;
}
// One printed line per call, so nothing echoed from a bounty can fake a RESULT line.
const oneLine = (s) => scrub(s).replace(/[\r\n\u2028\u2029]+/g, ' ');
const say = (...a) => console.log(oneLine(a.join(' ')));
// Bounty names and poidh text are untrusted: collapse whitespace and cap the length before showing them.
const shown = (s, n = 80) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
class Refusal extends Error {}
const refuse = (msg) => { throw new Refusal(msg); };

function account() {
  if (!RAW_KEY) refuse('POIDH_AGENT_KEY is not set in this environment.');
  if (!/^[0-9a-fA-F]{64}$/.test(RAW_KEY)) refuse('POIDH_AGENT_KEY is not a 32-byte hex private key.');
  return privateKeyToAccount(`0x${RAW_KEY}`);
}

// Read-only commands can name the wallet instead of holding its key.
function walletAddress(opts) {
  if (!opts.address) return account().address;
  if (!/^0x[0-9a-fA-F]{40}$/.test(opts.address)) refuse('--address must be a 0x wallet address.');
  return getAddress(opts.address);
}

function setup(chainName) {
  const cfg = CHAINS[chainName];
  if (!cfg) refuse(`Unknown chain "${chainName}". Use base, arbitrum or mainnet.`);
  if (cfg.test && !cfg.contract) refuse('POIDH_TEST_CONTRACT must be set for the local test chain.');
  const rpc = process.env[cfg.rpcEnv] || cfg.rpcDefault;
  if (!cfg.test && !rpc.startsWith('https://')) refuse(`${cfg.rpcEnv} must be an https URL.`);
  const pub = createPublicClient({ chain: cfg.chain, transport: http(rpc, { timeout: 20_000, retryCount: 2 }) });
  return { cfg, rpc, pub, address: cfg.contract };
}

async function verifyChain({ cfg, pub, address }) {
  const id = await pub.getChainId();
  if (id !== cfg.chain.id) refuse(`RPC is on chain ${id}, expected ${cfg.chain.id} (${cfg.chain.name}).`);
  const code = await pub.getCode({ address });
  if (!code || code === '0x') refuse(`No contract at ${address} on ${cfg.chain.name}.`);
}

const read = (ctx, functionName, args = []) =>
  ctx.pub.readContract({ address: ctx.address, abi: ABI, functionName, args });

// ---- Bounty lookup ----
async function poidhData(chainName, frontendId) {
  const site = CHAINS[chainName].test ? process.env.POIDH_TEST_SITE : 'https://poidh.xyz';
  if (!site) return null;
  const url = `${site}/${chainName}/bounty/${frontendId}/data`;
  let res;
  try { res = await fetch(url, { signal: AbortSignal.timeout(15_000) }); }
  catch (e) { refuse(`Could not reach ${new URL(url).host} (${e.cause?.message || e.message}); check the environment's allowed domains.`); }
  if (!res.ok) refuse(`poidh data for bounty ${frontendId} returned HTTP ${res.status}.`);
  return res.json();
}

async function resolveBounty(ctx, chainName, opts) {
  let data = null;
  let id;
  if (opts['onchain-id'] !== undefined) {
    id = BigInt(opts['onchain-id']);
  } else {
    if (!opts.bounty) refuse('Pass --bounty <frontend id> (or --onchain-id).');
    data = await poidhData(chainName, opts.bounty);
    if (!data || data.onChainId === undefined || data.onChainId === null) refuse('poidh data has no onChainId for this bounty.');
    id = BigInt(data.onChainId);
  }
  const counter = await read(ctx, 'bountyCounter');
  if (id >= counter) refuse(`Bounty ${id} does not exist onchain (bountyCounter is ${counter}).`);
  const [, issuer, name, description, amount, claimer] = await read(ctx, 'bounties', [id]);
  if (data) {
    if (typeof data.title !== 'string' || !data.title.trim()) refuse(`poidh data for bounty ${opts.bounty} has no title to check against the chain.`);
    if (data.title.trim() !== name.trim())
      refuse(`poidh data title "${shown(data.title)}" does not match onchain name "${shown(name)}" for bounty ${id}.`);
  }
  return { id, issuer, name, description, amount, claimer, data };
}

async function walletClaims(ctx, wallet) {
  // Walk userClaims(wallet, i) until it runs out; poidh's paged getters are unreliable.
  const out = [];
  for (let i = 0n; i < 10_000n; i++) {
    let claimId;
    try { claimId = await read(ctx, 'userClaims', [wallet, i]); }
    catch (e) {
      // Past the end of the array the getter reverts; anything else (RPC trouble) must not undercount.
      if (e instanceof BaseError && e.walk((x) => x instanceof ContractFunctionRevertedError)) break;
      throw e;
    }
    const [, , bountyId, , , , createdAt] = await read(ctx, 'claims', [claimId]);
    out.push({ claimId, bountyId, createdAt });
  }
  return out;
}

async function eligibility(ctx, bounty, wallet) {
  const problems = [];
  const ZERO = '0x0000000000000000000000000000000000000000';
  if (bounty.claimer.toLowerCase() === bounty.issuer.toLowerCase()) problems.push('the bounty is closed or cancelled');
  else if (bounty.claimer !== ZERO) problems.push('the bounty already has an accepted claim');
  const voting = await read(ctx, 'bountyCurrentVotingClaim', [bounty.id]);
  if (voting !== 0n) problems.push(`a vote is running on claim ${voting}`);
  if (wallet.toLowerCase() === bounty.issuer.toLowerCase()) problems.push('the agent wallet issued this bounty');
  const mine = await walletClaims(ctx, wallet);
  const dup = mine.find((c) => c.bountyId === bounty.id);
  if (dup) problems.push(`the agent wallet already claimed this bounty (claim ${dup.claimId})`);
  const now = (await ctx.pub.getBlock()).timestamp;
  const today = mine.filter((c) => now - c.createdAt < 86_400n).length;
  if (today >= MAX_CLAIMS_PER_DAY) problems.push(`the daily cap is reached (${today} of ${MAX_CLAIMS_PER_DAY} claims in the last 24 hours)`);
  return { problems, claimsToday: today };
}

// ---- Proof checks: the URI must be real, public media ----
function gatewayUrl(uri) {
  if (uri.startsWith('ipfs://')) return `https://ipfs.io/ipfs/${uri.slice(7).replace(/^ipfs\//, '')}`;
  return uri;
}

function vetUri(uri, testChain, what = 'Proof URI') {
  const ok = uri.startsWith('https://') || uri.startsWith('ipfs://') || (testChain && uri.startsWith('http://127.0.0.1'));
  if (!ok) refuse(`${what} must start with https:// or ipfs://.`);
  const host = uri.startsWith('ipfs://') ? 'ipfs' : new URL(uri).hostname;
  if (!testChain && /(^|\.)(example\.(com|org|net)|localhost|127\.0\.0\.1|0\.0\.0\.0)$/i.test(host)) refuse(`${what} host ${host} is a placeholder.`);
}

// Follows redirects by hand so every hop is vetted before it is fetched.
async function fetchVetted(url, testChain) {
  let current = gatewayUrl(url);
  for (let hop = 0; hop <= 5; hop++) {
    if (hop > 0) vetUri(current, testChain, 'Proof redirect target');
    let res;
    try { res = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(20_000) }); }
    catch (e) { refuse(`Could not fetch the proof from ${new URL(current).host} (${e.cause?.message || e.message}).`); }
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      current = new URL(location, current).toString();
      continue;
    }
    return res;
  }
  refuse('Proof URI redirects more than 5 times.');
}

async function checkProof(uri, testChain) {
  vetUri(uri, testChain);
  const media = async (url, depth) => {
    if (depth > 0) vetUri(url, testChain, 'Proof metadata image');
    const res = await fetchVetted(url, testChain);
    if (!res.ok) refuse(`Proof URI returned HTTP ${res.status}.`);
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (type.startsWith('image/') || type.startsWith('video/')) { await res.body?.cancel(); return type; }
    if (/\.(mp4|mov|webm|ogg)(\?|$)/i.test(url)) { await res.body?.cancel(); return 'video (by extension)'; }
    if (depth === 0 && type.includes('json')) {
      const meta = await res.json();
      if (typeof meta.image !== 'string' || !meta.image) refuse('Proof metadata JSON has no image field.');
      return `metadata -> ${await media(meta.image, 1)}`;
    }
    await res.body?.cancel();
    refuse(`Proof URI serves "${type || 'unknown'}", not an image, video or metadata JSON.`);
  };
  return media(uri, 0);
}

// ---- Fees ----
async function feeCheck(ctx, wallet, request) {
  const estimate = await ctx.pub.estimateContractGas({ ...request, account: wallet });
  const gas = (estimate * 12n) / 10n;
  const { maxFeePerGas, maxPriorityFeePerGas } = await ctx.pub.estimateFeesPerGas();
  const worst = gas * maxFeePerGas;
  if (worst > ctx.cfg.maxFee) refuse(`Fee could reach ${formatEther(worst)} ETH, above the ${formatEther(ctx.cfg.maxFee)} ETH cap.`);
  const balance = await ctx.pub.getBalance({ address: wallet });
  if (balance < worst) refuse(`Wallet holds ${formatEther(balance)} ETH, less than the ${formatEther(worst)} ETH fee.`);
  return { gas, maxFeePerGas, maxPriorityFeePerGas, worst, balance };
}

function revertReason(err) {
  if (err instanceof BaseError) {
    const r = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (r?.data?.errorName) return r.data.errorName;
    const h = err.walk((e) => e instanceof HttpRequestError);
    if (h) return `could not reach ${new URL(h.url).host} (${h.status ? `HTTP ${h.status}` : h.details || 'no response'}); check the environment's allowed domains`;
    return err.shortMessage;
  }
  return err?.message || String(err);
}

// ---- Commands ----
async function cmdStatus(ctx, opts) {
  const wallet = walletAddress(opts);
  await verifyChain(ctx);
  const [balance, pending, mine, block] = await Promise.all([
    ctx.pub.getBalance({ address: wallet }),
    read(ctx, 'pendingWithdrawals', [wallet]),
    walletClaims(ctx, wallet),
    ctx.pub.getBlock(),
  ]);
  const today = mine.filter((c) => block.timestamp - c.createdAt < 86_400n).length;
  say(`Agent wallet ${wallet} on ${ctx.cfg.chain.name}`);
  say(`Balance ${formatEther(balance)} ETH, winnings waiting ${formatEther(pending)} ETH`);
  say(`Claims ${mine.length} total, ${today} of ${MAX_CLAIMS_PER_DAY} in the last 24 hours`);
  return {
    wallet, balance: formatEther(balance), pending: formatEther(pending), claims: mine.length, claimsToday: today,
    claimed: mine.map((c) => ({ claimId: c.claimId.toString(), onchainBountyId: c.bountyId.toString() })),
  };
}

async function cmdCheck(ctx, chainName, opts) {
  await verifyChain(ctx);
  const wallet = walletAddress(opts);
  const b = await resolveBounty(ctx, chainName, opts);
  const { problems, claimsToday } = await eligibility(ctx, b, wallet);
  say(`Bounty ${b.id} "${shown(b.name)}" holds ${formatEther(b.amount)} ETH, issuer ${b.issuer}`);
  say(problems.length ? `Not claimable: ${problems.join('; ')}.` : `Claimable by ${wallet}.`);
  return { bountyId: b.id.toString(), name: shown(b.name), amount: formatEther(b.amount), issuer: b.issuer, claimable: !problems.length, problems, claimsToday };
}

async function cmdClaim(ctx, chainName, opts) {
  const acct = account();
  await verifyChain(ctx);
  const title = (opts.title || '').trim();
  const description = (opts['description-file'] ? readFileSync(opts['description-file'], 'utf8') : opts.description || '').trim();
  const proof = (opts['proof-uri'] || '').trim();
  if (!title || !description || !proof) refuse('Pass --title, --description (or --description-file) and --proof-uri.');
  if (title.length > MAX_TITLE) refuse(`Title is ${title.length} characters; the limit is ${MAX_TITLE}.`);
  if (description.length > MAX_DESCRIPTION) refuse(`Description is ${description.length} characters; the limit is ${MAX_DESCRIPTION}.`);
  for (const t of [title, description, proof]) if (RAW_KEY && t.toLowerCase().includes(RAW_KEY.toLowerCase())) refuse('Claim text contains the private key.');

  const b = await resolveBounty(ctx, chainName, opts);
  const { problems } = await eligibility(ctx, b, acct.address);
  if (problems.length) refuse(`Bounty ${b.id} "${shown(b.name)}" is not claimable: ${problems.join('; ')}.`);
  const proofType = await checkProof(proof, !!ctx.cfg.test);
  say(`Proof OK (${proofType})`);

  const request = { address: ctx.address, abi: ABI, functionName: 'createClaim', args: [b.id, title, description, proof] };
  try { await ctx.pub.simulateContract({ ...request, account: acct.address }); }
  catch (e) { refuse(`The contract would reject this claim: ${revertReason(e)}.`); }
  const fee = await feeCheck(ctx, acct.address, request);
  say(`Bounty ${b.id} "${shown(b.name)}" (${formatEther(b.amount)} ETH). Fee at most ${formatEther(fee.worst)} ETH.`);
  if (opts['dry-run']) { say('Dry run: not sent.'); return { dryRun: true, bountyId: b.id.toString(), maxFee: formatEther(fee.worst) }; }

  const wallet = createWalletClient({ account: acct, chain: ctx.cfg.chain, transport: http(ctx.rpc, { timeout: 20_000 }) });
  const hash = await wallet.writeContract({ ...request, gas: fee.gas, maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas });
  say(`Sent ${ctx.cfg.explorer}${hash}`);
  const receipt = await ctx.pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== 'success') refuse(`Transaction ${hash} reverted.`);
  let claimId = null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== ctx.address.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: ABI, data: log.data, topics: log.topics });
      if (ev.eventName === 'ClaimCreated' && ev.args.bountyId === b.id && ev.args.issuer.toLowerCase() === acct.address.toLowerCase()) claimId = ev.args.id;
    } catch { /* other events */ }
  }
  if (claimId === null) refuse(`Transaction ${hash} succeeded but no ClaimCreated event for bounty ${b.id} was found.`);
  say(`Claim ${claimId} created on bounty ${b.id}.`);
  return { tx: hash, link: `${ctx.cfg.explorer}${hash}`, claimId: claimId.toString(), bountyId: b.id.toString(), wallet: acct.address };
}

async function cmdWithdraw(ctx, opts) {
  const acct = account();
  await verifyChain(ctx);
  const pending = await read(ctx, 'pendingWithdrawals', [acct.address]);
  if (pending === 0n) refuse('Nothing to withdraw.');
  const request = { address: ctx.address, abi: ABI, functionName: 'withdraw', args: [] };
  try { await ctx.pub.simulateContract({ ...request, account: acct.address }); }
  catch (e) { refuse(`The contract would reject the withdraw: ${revertReason(e)}.`); }
  const fee = await feeCheck(ctx, acct.address, request);
  say(`Withdrawing ${formatEther(pending)} ETH to ${acct.address}. Fee at most ${formatEther(fee.worst)} ETH.`);
  if (opts['dry-run']) { say('Dry run: not sent.'); return { dryRun: true, amount: formatEther(pending) }; }
  const wallet = createWalletClient({ account: acct, chain: ctx.cfg.chain, transport: http(ctx.rpc, { timeout: 20_000 }) });
  const hash = await wallet.writeContract({ ...request, gas: fee.gas, maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas });
  say(`Sent ${ctx.cfg.explorer}${hash}`);
  const receipt = await ctx.pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== 'success') refuse(`Transaction ${hash} reverted.`);
  return { tx: hash, link: `${ctx.cfg.explorer}${hash}`, amount: formatEther(pending) };
}

async function main() {
  const { values: opts, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      chain: { type: 'string', default: 'base' }, bounty: { type: 'string' }, 'onchain-id': { type: 'string' },
      title: { type: 'string' }, description: { type: 'string' }, 'description-file': { type: 'string' },
      'proof-uri': { type: 'string' }, address: { type: 'string' }, 'dry-run': { type: 'boolean', default: false },
    },
  });
  const cmd = positionals[0];
  const ctx = setup(opts.chain);
  let result;
  if (cmd === 'status') result = await cmdStatus(ctx, opts);
  else if (cmd === 'check') result = await cmdCheck(ctx, opts.chain, opts);
  else if (cmd === 'claim') result = await cmdClaim(ctx, opts.chain, opts);
  else if (cmd === 'withdraw') result = await cmdWithdraw(ctx, opts);
  else refuse('Command must be status, check, claim or withdraw.');
  say(`RESULT ${JSON.stringify({ ok: true, command: cmd, chain: opts.chain, ...result }, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
}

main().catch((e) => {
  const msg = e instanceof Refusal ? `Refused: ${e.message}` : `Error: ${revertReason(e)}`;
  console.error(oneLine(msg));
  console.log(oneLine(`RESULT ${JSON.stringify({ ok: false, error: msg })}`));
  process.exit(e instanceof Refusal ? 2 : 1);
});
