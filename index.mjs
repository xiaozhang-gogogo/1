import { getStore } from '@netlify/blobs';
import { createRequire } from 'node:module';
import { Readable, Writable } from 'node:stream';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);

process.env.DATA_DIR = process.env.TREEHOLE_DATA_DIR || '/tmp/treehole-netlify/data';
process.env.HOST = '127.0.0.1';
process.env.PORT = '5173';
process.env.TRUST_PROXY = process.env.TRUST_PROXY || '1';
process.env.REQUIRE_LOGIN = process.env.REQUIRE_LOGIN || '1';
process.env.TZ = process.env.TZ || 'Asia/Shanghai';
process.env.DEFAULT_TIME_ZONE = process.env.DEFAULT_TIME_ZONE || 'Asia/Shanghai';
process.env.BACKUP_INTERVAL_HOURS = '0';
process.env.IMAGE_CLEANUP_INTERVAL_HOURS = '0';
process.env.IMAGE_MAX_BYTES = process.env.IMAGE_MAX_BYTES || String(4 * 1024 * 1024);
process.env.STRUCTURED_LOGS = process.env.STRUCTURED_LOGS || '0';

const core = require('./server-core.cjs');

const BLOB_STORE_NAME = process.env.TREEHOLE_BLOB_STORE || 'treehole';
const STORE_KEY = 'state/store.json';
const LOCK_KEY = 'locks/api';
const LOCK_TTL_MS = 15_000;
const LOCK_WAIT_MS = 6_000;
const blobs = getStore({ name: BLOB_STORE_NAME, consistency: 'strong' });

const IMAGE_NAME_RE = /^[a-f0-9]{16,32}\.(png|jpg|gif|webp)$/;
const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};
const IMAGE_KEY_PREFIX = 'images/';
const MAX_IMAGE_HYDRATIONS = 24;
const NO_BODY_STATUS = new Set([101, 204, 205, 304]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class NodeRequest extends Readable {
  constructor(request, body, url, ip) {
    super();
    this.method = request.method || 'GET';
    this.url = url.pathname + url.search;
    this.headers = Object.fromEntries(request.headers.entries());
    if (!this.headers.host) this.headers.host = url.host;
    this.httpVersion = '1.1';
    this.complete = true;
    this.socket = {
      remoteAddress: ip,
      setKeepAlive() {},
      setNoDelay() {},
    };
    this.connection = this.socket;
    this._body = body;
    this._sent = false;
  }

  _read() {
    if (this._sent) return;
    this._sent = true;
    if (this._body && this._body.length) this.push(Buffer.from(this._body));
    this.push(null);
  }
}

class NodeResponse extends Writable {
  constructor() {
    super();
    this.statusCode = 200;
    this.statusMessage = '';
    this.headers = {};
    this.headersSent = false;
    this.chunks = [];
    this.socket = {
      setKeepAlive() {},
      setNoDelay() {},
    };
    this._resolveFinished = null;
    this.finishedResponse = new Promise((resolve) => {
      this._resolveFinished = resolve;
    });
    this.once('finish', () => this._resolveFinished());
  }

  setHeader(name, value) {
    this.headers[String(name).toLowerCase()] = value;
  }

  getHeader(name) {
    return this.headers[String(name).toLowerCase()];
  }

  getHeaders() {
    return { ...this.headers };
  }

  removeHeader(name) {
    delete this.headers[String(name).toLowerCase()];
  }

  writeHead(statusCode, statusMessage, headers) {
    this.statusCode = Number(statusCode) || 200;
    if (typeof statusMessage === 'object' && statusMessage !== null) {
      headers = statusMessage;
    } else if (statusMessage) {
      this.statusMessage = String(statusMessage);
    }
    if (headers && typeof headers === 'object') {
      for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    }
    this.headersSent = true;
    return this;
  }

  flushHeaders() {
    this.headersSent = true;
  }

  _write(chunk, encoding, callback) {
    try {
      this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      callback();
    } catch (error) {
      callback(error);
    }
  }

  _final(callback) {
    callback();
  }

  toResponse(head = false) {
    const headers = new Headers();
    for (const [name, value] of Object.entries(this.headers)) {
      if (value === undefined || value === null) continue;
      for (const item of Array.isArray(value) ? value : [value]) headers.append(name, String(item));
    }
    const body = head || NO_BODY_STATUS.has(this.statusCode) ? null : Buffer.concat(this.chunks);
    return new Response(body, { status: this.statusCode, headers });
  }
}

let localQueue = Promise.resolve();
function serialize(task) {
  const current = localQueue.then(task, task);
  localQueue = current.catch(() => {});
  return current;
}

async function acquireLock() {
  const token = randomUUID();
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    let current = null;
    try {
      const raw = await blobs.get(LOCK_KEY);
      current = raw ? JSON.parse(raw) : null;
    } catch {
      current = null;
    }
    if (!current || !current.expiresAt || Number(current.expiresAt) <= Date.now()) {
      const payload = JSON.stringify({ token, expiresAt: Date.now() + LOCK_TTL_MS });
      await blobs.set(LOCK_KEY, payload);
      const confirmation = await blobs.get(LOCK_KEY);
      const parsed = confirmation ? JSON.parse(confirmation) : null;
      if (parsed && parsed.token === token) return token;
    }
    await sleep(90 + Math.floor(Math.random() * 120));
  }
  throw new Error('Treehole data is busy, please retry shortly.');
}

async function releaseLock(token) {
  try {
    const raw = await blobs.get(LOCK_KEY);
    const current = raw ? JSON.parse(raw) : null;
    if (current && current.token === token) await blobs.delete(LOCK_KEY);
  } catch {
    // The lock also has a TTL, so a cleanup failure cannot block the site forever.
  }
}

async function hydrateStore() {
  const raw = await blobs.get(STORE_KEY);
  core.clearPendingSave();
  core.replaceStore(raw ? JSON.parse(raw) : null);
  core.ensureDirs();
  return typeof raw === 'string' ? raw : JSON.stringify(core.snapshotStore());
}

async function persistStore(previousRaw) {
  core.clearPendingSave();
  const raw = JSON.stringify(core.snapshotStore());
  if (raw === previousRaw) return false;
  core.flush();
  await blobs.set(STORE_KEY, raw);
  return true;
}

async function listUploads() {
  try {
    const entries = await fs.promises.readdir(core.UPLOAD_DIR, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && IMAGE_NAME_RE.test(entry.name)).map((entry) => entry.name);
  } catch {
    return [];
  }
}

function toArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

async function persistImages(names) {
  for (const name of names) {
    const body = await fs.promises.readFile(path.join(core.UPLOAD_DIR, name));
    await blobs.set(IMAGE_KEY_PREFIX + name, toArrayBuffer(body));
  }
}

async function cleanupUploads(names) {
  for (const name of names) {
    try {
      await fs.promises.rm(path.join(core.UPLOAD_DIR, name), { force: true });
    } catch {
      // /tmp cleanup is best effort.
    }
  }
}

function collectImageNames(body, url) {
  const names = new Set();
  const add = (value) => {
    if (typeof value !== 'string') return;
    for (const match of value.matchAll(/[a-f0-9]{16,32}\.(?:png|jpg|gif|webp)/g)) names.add(match[0]);
  };
  for (const value of url.searchParams.values()) add(value);
  if (body && body.length) add(body.toString('utf8'));
  return [...names].filter((name) => IMAGE_NAME_RE.test(name)).slice(0, MAX_IMAGE_HYDRATIONS);
}

async function hydrateImages(names) {
  if (!names.length) return;
  await fs.promises.mkdir(core.UPLOAD_DIR, { recursive: true });
  for (const name of names) {
    const target = path.join(core.UPLOAD_DIR, name);
    try {
      if ((await fs.promises.stat(target)).isFile()) continue;
    } catch {
      // Missing in this function instance; restore it from Blobs below.
    }
    const body = await blobs.get(IMAGE_KEY_PREFIX + name, { type: 'arrayBuffer' });
    if (!body) continue;
    await fs.promises.writeFile(target, Buffer.from(body));
  }
}

function requestIp(request, url) {
  return request.headers.get('x-nf-client-connection-ip')
    || (request.headers.get('x-forwarded-for') || '').split(',')[0].trim()
    || 'netlify';
}

function jsonError(status, message, details = {}) {
  return new Response(JSON.stringify({ error: message, ...details }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

async function serveImage(request, url) {
  const name = url.pathname.slice('/api/images/'.length);
  if (!IMAGE_NAME_RE.test(name)) return jsonError(404, '图片不存在。');
  const body = await blobs.get(IMAGE_KEY_PREFIX + name, { type: 'arrayBuffer' });
  if (!body) return jsonError(404, '图片不存在。');
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  const headers = {
    'Content-Type': IMAGE_MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'public, max-age=31536000, immutable',
  };
  return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers });
}

async function runApi(request, url) {
  if (url.pathname === '/api/events') {
    return new Response(null, {
      status: 204,
      headers: {
        'Cache-Control': 'no-store',
        'X-Treehole-Realtime': 'polling',
      },
    });
  }

  if (url.pathname.startsWith('/api/images/') && (request.method === 'GET' || request.method === 'HEAD')) {
    return serveImage(request, url);
  }

  const body = request.method === 'GET' || request.method === 'HEAD'
    ? Buffer.alloc(0)
    : Buffer.from(await request.arrayBuffer());

  const lockToken = await acquireLock();
  try {
    const previousStore = await hydrateStore();
    await hydrateImages(collectImageNames(body, url));
    const beforeUploads = new Set(await listUploads());
    const req = new NodeRequest(request, body, url, requestIp(request, url));
    const res = new NodeResponse();
    await core.requestHandler(req, res);
    if (!res.writableEnded) {
      if (!res.headersSent) res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '接口不存在。' }));
    }
    await res.finishedResponse;

    const afterUploads = await listUploads();
    const newUploads = afterUploads.filter((name) => !beforeUploads.has(name));
    await persistImages(newUploads);
    await persistStore(previousStore);
    await cleanupUploads(newUploads);

    return res.toResponse(request.method === 'HEAD');
  } finally {
    core.clearPendingSave();
    await releaseLock(lockToken);
  }
}

export default async function handler(request) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return jsonError(404, '接口不存在。');
  try {
    return await serialize(() => runApi(request, url));
  } catch (error) {
    console.error('[treehole-netlify]', error);
    return jsonError(503, '树洞暂时无法保存数据，请稍后重试。', { code: 'NETLIFY_STORAGE_UNAVAILABLE' });
  }
}

export const config = {
  path: '/api/*',
};