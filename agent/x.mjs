// poidh agent: the X (Twitter) client the signer uses to publish posts from the agent's account.
// Only sign-requests.mjs uses it, inside the signer workflow, with the four X keys from its
// environment. Nothing here prints a key; errors carry only X's status and short error text.

import { createHmac, randomBytes } from 'node:crypto';

const API = process.env.X_API_BASE || 'https://api.x.com';
const KEY_NAMES = ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET'];
export const MAX_POST_WEIGHT = 280;

export class XError extends Error {}

// The keys, or null when any of the four is missing (posting is then switched off).
export function xKeys() {
  const [consumerKey, consumerSecret, token, tokenSecret] = KEY_NAMES.map((k) => (process.env[k] || '').trim());
  if (!consumerKey || !consumerSecret || !token || !tokenSecret) return null;
  return { consumerKey, consumerSecret, token, tokenSecret };
}

// Every X key value, so callers can scrub them from anything they print.
export const xSecretValues = () => KEY_NAMES.map((k) => (process.env[k] || '').trim()).filter((v) => v.length >= 8);

// RFC 3986 percent-encoding, as OAuth 1.0a requires.
const pct = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// OAuth 1.0a (HMAC-SHA1) Authorization header. `params` are form-encoded body parameters, which
// are signed; JSON and multipart bodies are not, so X's v2 calls pass none.
export function oauthHeader(method, url, keys, { params = {}, nonce = randomBytes(16).toString('hex'), timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const u = new URL(url);
  const oauth = {
    oauth_consumer_key: keys.consumerKey, oauth_nonce: nonce, oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(timestamp), oauth_token: keys.token, oauth_version: '1.0',
  };
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const pairs = [...u.searchParams, ...Object.entries(params), ...Object.entries(oauth)]
    .map(([k, v]) => [pct(k), pct(String(v))]).sort(([k1, v1], [k2, v2]) => cmp(k1, k2) || cmp(v1, v2));
  const base = [method.toUpperCase(), pct(`${u.origin}${u.pathname}`), pct(pairs.map(([k, v]) => `${k}=${v}`).join('&'))].join('&');
  const signature = createHmac('sha1', `${pct(keys.consumerSecret)}&${pct(keys.tokenSecret)}`).update(base).digest('base64');
  return `OAuth ${Object.entries({ ...oauth, oauth_signature: signature }).map(([k, v]) => `${pct(k)}="${pct(v)}"`).join(', ')}`;
}

// X's length rule, erring long: links count 23, and characters outside Latin and common
// punctuation (CJK, emoji) count 2. A bare domain counts at least 23, in case X links it.
export function postWeight(text) {
  let n = 0;
  const rest = text.normalize('NFC')
    .replace(/https?:\/\/\S+/gi, () => { n += 23; return ''; })
    .replace(/\b[\w-]+(\.[\w-]+)*\.[a-z]{2,}\b(\/\S*)?/gi, (m) => { n += Math.max(23, [...m].length); return ''; });
  for (const ch of rest) {
    const cp = ch.codePointAt(0);
    const light = cp <= 0x10ff || (cp >= 0x2000 && cp <= 0x200d) || (cp >= 0x2010 && cp <= 0x201f) || (cp >= 0x2032 && cp <= 0x2037);
    n += light ? 1 : 2;
  }
  return n;
}

function describe(status, json) {
  const e = json?.errors?.[0] || json || {};
  const msg = [e.title, e.detail || e.message].filter((s) => typeof s === 'string').join(': ');
  return `HTTP ${status}${msg ? `, ${msg.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`;
}

async function call(keys, path, { method = 'POST', body, headers = {} } = {}) {
  const url = `${API}${path}`;
  let res;
  try {
    res = await fetch(url, {
      method, body, redirect: 'error', signal: AbortSignal.timeout(60_000),
      headers: { Authorization: oauthHeader(method, url, keys), ...headers },
    });
  } catch (e) { throw new XError(`could not reach ${new URL(url).host} (${e.cause?.code || e.name})`); }
  let json = null;
  try { json = JSON.parse(await res.text()); } catch { /* reported by status */ }
  return { status: res.status, json };
}

// The @handle the keys post as. Dry runs call this to prove the keys work without posting.
export async function whoAmI(keys) {
  const { status, json } = await call(keys, '/2/users/me', { method: 'GET' });
  const handle = String(json?.data?.username ?? '');
  if (status >= 300 || !/^\w{1,15}$/.test(handle)) throw new XError(`X did not accept the keys (${describe(status, json)})`);
  return handle;
}

// Uploads one image and returns its media id.
export async function uploadImage(keys, bytes, type) {
  const form = new FormData();
  form.append('media', new Blob([bytes], { type }), 'proof');
  form.append('media_category', 'tweet_image');
  const { status, json } = await call(keys, '/2/media/upload', { body: form });
  const id = String(json?.data?.id ?? json?.media_id_string ?? '');
  if (status >= 300 || !/^\d{1,30}$/.test(id)) throw new XError(`X refused the image upload (${describe(status, json)})`);
  return id;
}

// Publishes one post and returns its id and link.
export async function createPost(keys, text, mediaId) {
  const body = JSON.stringify(mediaId ? { text, media: { media_ids: [mediaId] } } : { text });
  const { status, json } = await call(keys, '/2/tweets', { body, headers: { 'Content-Type': 'application/json' } });
  const id = String(json?.data?.id ?? '');
  if (status >= 300 || !/^\d{1,30}$/.test(id)) throw new XError(`X refused the post (${describe(status, json)})`);
  return { id, url: `https://x.com/i/status/${id}` };
}
