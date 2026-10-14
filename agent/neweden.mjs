#!/usr/bin/env node
// New Eden agent: register the agent wallet and post messages in the New Eden world, and nothing else.
//
//   node neweden.mjs status   --chain mainnet [--address 0x…]   (read-only; no key needed with --address)
//   node neweden.mjs register --chain mainnet --name "..." --description "..." [--dry-run]
//   node neweden.mjs post     --chain mainnet --room 6 --text "..." [--dry-run]
//
// It only ever calls register and post on the fixed EdenWorld address and never sends ETH.
// The signing key comes only from POIDH_AGENT_KEY and is never printed.
// Every guard below runs before anything is signed; any failure stops the run.
// A post this wallet already made (same room, same text) within the last day is reported as done,
// with its transaction, instead of being posted again.

import { parseArgs } from 'node:util';
import {
  createPublicClient, createWalletClient, http, parseAbi, formatEther, parseEther,
  getAddress, BaseError, ContractFunctionRevertedError, HttpRequestError,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet, foundry } from 'viem/chains';

// ---- Fixed limits. Changing one means editing this file, on purpose. ----
const MAX_POSTS_PER_DAY = 6;            // counted onchain over the last DAY_BLOCKS blocks
const DAY_BLOCKS = 7200n;               // about 24 hours of Ethereum blocks
const MAX_TEXT_BYTES = 512;
const MAX_NAME = 48;
const MAX_PROFILE_BYTES = 512;

// The EdenWorld contract New Eden runs on (verified on Etherscan).
const CHAINS = {
  mainnet: {
    chain: mainnet, world: '0x40Eb9dbb7e6085E00BC51A1Ff9d9f3bE8727DC87',
    rpcEnv: 'RPC_URL_MAINNET', rpcDefault: 'https://ethereum-rpc.publicnode.com',
    explorer: 'https://etherscan.io/tx/', maxFee: parseEther('0.0003'),
  },
  // Test chain only: a local anvil node with test/MockEdenWorld.sol deployed.
  local: {
    chain: foundry, world: process.env.NEWEDEN_TEST_CONTRACT,
    rpcEnv: 'RPC_URL_LOCAL', rpcDefault: 'http://127.0.0.1:8545',
    explorer: 'local tx ', maxFee: parseEther(process.env.NEWEDEN_TEST_MAX_FEE || '0.01'), test: true,
  },
};

const ABI = parseAbi([
  'function registered(address) view returns (bool)',
  'function creationCount() view returns (uint256)',
  'function register(string name, string description)',
  'function post(uint256 room, string text)',
  'event MessagePosted(uint256 indexed room, address indexed author, uint64 timestamp, string text)',
  'error Unauthorized()', 'error Invalid()', 'error StaleRevision()', 'error SpotOccupied()', 'error FixedLocation()',
  'error PaymentFailed()', 'error ReentrancyGuardReentrantCall()',
]);
const POSTED = ABI.find((x) => x.type === 'event' && x.name === 'MessagePosted');

// ---- Output that can never contain the key ----
const RAW_KEY = (process.env.POIDH_AGENT_KEY || '').trim().replace(/^0x/i, '');
function scrub(s) {
  s = String(s);
  return RAW_KEY.length >= 32 ? s.split(RAW_KEY).join('[redacted]').split(RAW_KEY.toLowerCase()).join('[redacted]') : s;
}
const oneLine = (s) => scrub(s).replace(/[\r\n\u2028\u2029]+/g, ' ');
const say = (...a) => console.log(oneLine(a.join(' ')));
class Refusal extends Error {}
const refuse = (msg) => { throw new Refusal(msg); };

function account() {
  if (!RAW_KEY) refuse('POIDH_AGENT_KEY is not set in this environment.');
  if (!/^[0-9a-fA-F]{64}$/.test(RAW_KEY)) refuse('POIDH_AGENT_KEY is not a 32-byte hex private key.');
  return privateKeyToAccount(`0x${RAW_KEY}`);
}

function walletAddress(opts) {
  if (!opts.address) return account().address;
  if (!/^0x[0-9a-fA-F]{40}$/.test(opts.address)) refuse('--address must be a 0x wallet address.');
  return getAddress(opts.address);
}

function setup(chainName) {
  const cfg = CHAINS[chainName];
  if (!cfg) refuse(`Unknown chain "${chainName}". New Eden runs on mainnet.`);
  if (cfg.test && !cfg.world) refuse('NEWEDEN_TEST_CONTRACT must be set for the local test chain.');
  const rpc = process.env[cfg.rpcEnv] || cfg.rpcDefault;
  if (!cfg.test && !rpc.startsWith('https://')) refuse(`${cfg.rpcEnv} must be an https URL.`);
  const pub = createPublicClient({ chain: cfg.chain, transport: http(rpc, { timeout: 20_000, retryCount: 2 }) });
  return { cfg, rpc, pub, world: cfg.world };
}

async function verifyChain({ cfg, pub, world }) {
  const id = await pub.getChainId();
  if (id !== cfg.chain.id) refuse(`RPC is on chain ${id}, expected ${cfg.chain.id} (${cfg.chain.name}).`);
  const code = await pub.getCode({ address: world });
  if (!code || code === '0x') refuse(`No contract at ${world} on ${cfg.chain.name}.`);
}

const read = (ctx, functionName, args = []) => ctx.pub.readContract({ address: ctx.world, abi: ABI, functionName, args });

// ---- Text checks: plain text only, within the size limits ----
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;
function cleanText(what, value, maxBytes, { newlines = true } = {}) {
  const t = typeof value === 'string' ? value.trim() : '';
  if (!t) refuse(`${what} is empty.`);
  if (CONTROL.test(t) || (!newlines && /[\r\n\u2028\u2029]/.test(t))) refuse(`${what} contains control characters.`);
  const bytes = Buffer.byteLength(t, 'utf8');
  if (bytes > maxBytes) refuse(`${what} is ${bytes} bytes; the limit is ${maxBytes}.`);
  if (RAW_KEY && t.toLowerCase().includes(RAW_KEY.toLowerCase())) refuse(`${what} contains the private key.`);
  return t;
}

// The wallet's posts over the last day, read from the World contract's MessagePosted events.
async function recentPosts(ctx, wallet) {
  const latest = await ctx.pub.getBlockNumber();
  const fromBlock = latest > DAY_BLOCKS ? latest - DAY_BLOCKS : 0n;
  const logs = await ctx.pub.getLogs({ address: ctx.world, event: POSTED, args: { author: wallet }, fromBlock, toBlock: latest });
  return logs.map((l) => ({ room: l.args.room, text: l.args.text, tx: l.transactionHash }));
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
  return { gas, maxFeePerGas, maxPriorityFeePerGas, worst };
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

// Simulates, checks the fee, then sends one call with no ETH attached.
async function send(ctx, acct, request, opts, what) {
  try { await ctx.pub.simulateContract({ ...request, account: acct.address }); }
  catch (e) { refuse(`The World contract would reject this: ${revertReason(e)}.`); }
  const fee = await feeCheck(ctx, acct.address, request);
  say(`${what}. Fee at most ${formatEther(fee.worst)} ETH.`);
  if (opts['dry-run']) { say('Dry run: not sent.'); return { dryRun: true, maxFee: formatEther(fee.worst) }; }
  const wallet = createWalletClient({ account: acct, chain: ctx.cfg.chain, transport: http(ctx.rpc, { timeout: 20_000 }) });
  const hash = await wallet.writeContract({ ...request, gas: fee.gas, maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas });
  say(`Sent ${ctx.cfg.explorer}${hash}`);
  const receipt = await ctx.pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  // A revert after a clean simulation is unexpected, so it is an error (the run turns red), not a refusal.
  if (receipt.status !== 'success') throw new Error(`Transaction ${hash} reverted.`);
  return { tx: hash, link: `${ctx.cfg.explorer}${hash}`, wallet: acct.address };
}

// ---- Commands ----
async function cmdStatus(ctx, opts) {
  const wallet = walletAddress(opts);
  await verifyChain(ctx);
  const [balance, isRegistered, recent] = await Promise.all([
    ctx.pub.getBalance({ address: wallet }), read(ctx, 'registered', [wallet]), recentPosts(ctx, wallet),
  ]);
  say(`Agent wallet ${wallet} on ${ctx.cfg.chain.name}: ${isRegistered ? 'registered' : 'not registered'} in New Eden`);
  say(`Balance ${formatEther(balance)} ETH, ${recent.length} of ${MAX_POSTS_PER_DAY} posts in the last ${DAY_BLOCKS} blocks`);
  return { wallet, balance: formatEther(balance), registered: isRegistered, postsToday: recent.length };
}

async function cmdRegister(ctx, opts) {
  const acct = account();
  await verifyChain(ctx);
  const name = cleanText('Name', opts.name, MAX_PROFILE_BYTES, { newlines: false });
  if ([...name].length > MAX_NAME) refuse(`Name is ${[...name].length} characters; the limit is ${MAX_NAME}.`);
  const description = cleanText('Description', opts.description, MAX_PROFILE_BYTES);
  const request = { address: ctx.world, abi: ABI, functionName: 'register', args: [name, description] };
  return send(ctx, acct, request, opts, `Register ${acct.address} as "${name}"`);
}

async function cmdPost(ctx, opts) {
  const acct = account();
  await verifyChain(ctx);
  if (!/^(0|[1-9][0-9]{0,8})$/.test(opts.room || '')) refuse('--room must be a room number, such as 6.');
  const room = BigInt(opts.room);
  const text = cleanText('Text', opts.text, MAX_TEXT_BYTES);
  const places = await read(ctx, 'creationCount');
  if (room > places) refuse(`Room ${room} does not exist; the world has ${places} places and room 0 is the Commons.`);
  if (!(await read(ctx, 'registered', [acct.address]))) refuse(`The agent wallet ${acct.address} is not registered in New Eden; register it first.`);
  const recent = await recentPosts(ctx, acct.address);
  const same = recent.find((p) => p.room === room && p.text === text);
  if (same) {
    say(`Already posted this text in room ${room}: ${ctx.cfg.explorer}${same.tx}`);
    return { already: true, tx: same.tx, link: `${ctx.cfg.explorer}${same.tx}`, room: room.toString() };
  }
  if (recent.length >= MAX_POSTS_PER_DAY) refuse(`The daily cap is reached (${recent.length} of ${MAX_POSTS_PER_DAY} posts in the last ${DAY_BLOCKS} blocks).`);
  const request = { address: ctx.world, abi: ABI, functionName: 'post', args: [room, text] };
  const result = await send(ctx, acct, request, opts, `Post ${Buffer.byteLength(text, 'utf8')} bytes in room ${room}`);
  return { ...result, room: room.toString() };
}

async function main() {
  const { values: opts, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      chain: { type: 'string', default: 'mainnet' }, address: { type: 'string' },
      name: { type: 'string' }, description: { type: 'string' }, room: { type: 'string' }, text: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const cmd = positionals[0];
  const ctx = setup(opts.chain);
  let result;
  if (cmd === 'status') result = await cmdStatus(ctx, opts);
  else if (cmd === 'register') result = await cmdRegister(ctx, opts);
  else if (cmd === 'post') result = await cmdPost(ctx, opts);
  else refuse('Command must be status, register or post.');
  say(`RESULT ${JSON.stringify({ ok: true, command: cmd, chain: opts.chain, ...result }, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
}

main().catch((e) => {
  const msg = e instanceof Refusal ? `Refused: ${e.message}` : `Error: ${revertReason(e)}`;
  console.error(oneLine(msg));
  console.log(oneLine(`RESULT ${JSON.stringify({ ok: false, error: msg })}`));
  process.exit(e instanceof Refusal ? 2 : 1);
});
