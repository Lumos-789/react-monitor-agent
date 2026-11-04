// server —— node:http 路由 + CORS + 信封 + 错误映射 + 静态托管 board 产物(tech-design §2/§7)。
import { createServer as httpCreateServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { ApiError } from './errors.js';
import { Store } from './store.js';

const BODY_LIMIT_BYTES = 16 * 1024 * 1024;
const CORS_ORIGINS = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);
// 只绑 127.0.0.1 的本地服务只信任 localhost 系 Host;其余(如 DNS rebinding 域名)拒绝,防网页 rebind 后变同源打 API。
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const STATIC_MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  txt: 'text/plain; charset=utf-8',
  map: 'application/json',
  wasm: 'application/wasm',
};

const EVIDENCE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  pdf: 'application/pdf',
};

export interface CoreServerOptions {
  version: string;
  staticDirs?: string[];
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body?: unknown;
}

interface Route {
  method: string;
  parts: string[];
  handler: (c: Ctx) => Promise<void>;
}

function requireBody(c: Ctx): Record<string, unknown> {
  if (!c.body || typeof c.body !== 'object' || Array.isArray(c.body)) {
    throw new ApiError(400, 'BAD_REQUEST', 'request body must be a JSON object');
  }
  return c.body as Record<string, unknown>;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function sendOk(res: ServerResponse, data: unknown, status = 200, extraHeaders?: Record<string, string>): void {
  if (extraHeaders) for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  sendJson(res, status, { ok: true, data });
}

/** 拒绝留痕:每个 4xx/5xx 响应打一行(方法 路径 状态 码 原因),4xx=warn(归因调用方) 5xx=error(core 自身);消息压平单行防日志注入。 */
function logRejection(req: IncomingMessage, status: number, code: string, message: string): void {
  const flat = message.replace(/\s+/g, ' ').slice(0, 300);
  const line = `[rma-core] ${req.method ?? '?'} ${req.url ?? '?'} → ${status} ${code}: ${flat}`;
  if (status >= 500) console.error(line);
  else console.warn(line);
}

function sendError(req: IncomingMessage, res: ServerResponse, err: unknown): void {
  if (err instanceof ApiError) {
    logRejection(req, err.status, err.code, err.message);
    sendJson(res, err.status, { ok: false, error: { code: err.code, message: err.message } });
    return;
  }
  logRejection(req, 500, 'INTERNAL', err instanceof Error ? err.message : String(err));
  console.error('[rma-core] internal error detail:', err);
  sendJson(res, 500, {
    ok: false,
    error: { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) },
  });
}

/** /api/* 全部响应回显白名单内 origin;白名单外不加头(浏览器侧拦截)(tech-design §7) */
function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && CORS_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
  }
}

function hostAllowed(req: IncomingMessage): boolean {
  const host = req.headers.host;
  if (typeof host !== 'string' || host === '') return false;
  return ALLOWED_HOSTS.has(host.replace(/:\d+$/, '').toLowerCase());
}

function parseQueryInt(query: URLSearchParams, name: string, opts: { min: number; max?: number; clampMax?: boolean }): number {
  const raw = query.get(name);
  if (raw === null) return opts.min;
  if (!/^\d+$/.test(raw)) throw new ApiError(400, 'BAD_REQUEST', `query param "${name}" must be a non-negative integer`);
  let n = Number(raw);
  if (n < opts.min) throw new ApiError(400, 'BAD_REQUEST', `query param "${name}" must be >= ${opts.min}`);
  if (opts.max !== undefined && n > opts.max) {
    if (opts.clampMax) return opts.max;
    throw new ApiError(400, 'BAD_REQUEST', `query param "${name}" must be <= ${opts.max}`);
  }
  return n;
}

function safeStat(p: string) {
  try {
    return statSync(p);
  } catch {
    return undefined;
  }
}

/** 静态托管 board 产物(prod 同源);无产物目录时返回 false → 404。 */
function serveStatic(res: ServerResponse, pathname: string, roots: string[], head: boolean): boolean {
  const root = roots.find((d) => existsSync(d));
  if (!root) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  let filePath = resolve(root, '.' + decoded);
  if (!filePath.startsWith(root + sep) && filePath !== root) filePath = join(root, 'index.html');
  let st = safeStat(filePath);
  if (!st || st.isDirectory()) {
    filePath = join(root, 'index.html');
    st = safeStat(filePath);
  }
  if (!st || st.isDirectory()) return false;
  const ext = extname(filePath).slice(1).toLowerCase();
  const mime = STATIC_MIME[ext] ?? 'application/octet-stream';
  const data = readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': data.length,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': ext === 'html' ? 'no-cache' : 'public, max-age=3600',
  });
  res.end(head ? undefined : data);
  return true;
}

function buildRoutes(store: Store, startedAt: number, version: string): Route[] {
  const routes: Route[] = [];

  const register = (method: string, path: string, handler: (c: Ctx) => Promise<void>): void => {
    routes.push({ method, parts: path.split('/').filter(Boolean), handler });
  };

  // 1. GET /api/health
  register('GET', '/api/health', async (c) => {
    sendOk(c.res, { version, uptimeMs: Date.now() - startedAt, works: store.worksCount() });
  });

  // 2. POST /api/works
  register('POST', '/api/works', async (c) => {
    const { work, replay } = store.createWork(requireBody(c));
    sendOk(c.res, work, replay ? 200 : 201, replay ? { 'X-Idempotent-Replay': 'true' } : undefined);
  });

  // 3. GET /api/works
  register('GET', '/api/works', async (c) => {
    sendOk(c.res, store.listWorks({ track: c.query.get('track') ?? undefined, status: c.query.get('status') ?? undefined }));
  });

  // 4. GET /api/works/:workId
  register('GET', '/api/works/:workId', async (c) => {
    sendOk(c.res, store.getWork(c.params.workId));
  });

  // 5. GET /api/works/:workId/timeline
  register('GET', '/api/works/:workId/timeline', async (c) => {
    const sinceSeq = parseQueryInt(c.query, 'sinceSeq', { min: 0 });
    sendOk(c.res, store.timeline(c.params.workId, sinceSeq));
  });

  // 6. POST /api/works/:workId/events
  register('POST', '/api/works/:workId/events', async (c) => {
    sendOk(c.res, store.postEvent(c.params.workId, requireBody(c)), 201);
  });

  // 7. POST /api/works/:workId/checkpoints
  register('POST', '/api/works/:workId/checkpoints', async (c) => {
    sendOk(c.res, store.raiseCheckpoint(c.params.workId, requireBody(c)), 201);
  });

  // 8. POST /api/checkpoints/:checkpointId/decisions
  register('POST', '/api/checkpoints/:checkpointId/decisions', async (c) => {
    sendOk(c.res, store.decide(c.params.checkpointId, requireBody(c)), 201);
  });

  // 9. GET /api/works/:workId/inbox
  register('GET', '/api/works/:workId/inbox', async (c) => {
    const wait = parseQueryInt(c.query, 'wait', { min: 0, max: 60, clampMax: true });
    const decisions = await store.inbox(c.params.workId, wait);
    sendOk(c.res, { decisions });
  });

  // 10. POST /api/decisions/:decisionId/ack
  register('POST', '/api/decisions/:decisionId/ack', async (c) => {
    if (c.body !== undefined) requireBody(c);
    sendOk(c.res, store.ackDecision(c.params.decisionId));
  });

  // 11. GET /api/works/:workId/evidence/:fileId
  register('GET', '/api/works/:workId/evidence/:fileId', async (c) => {
    const { absPath, ext } = store.findEvidence(c.params.workId, c.params.fileId);
    const data = readFileSync(absPath);
    c.res.writeHead(200, {
      'Content-Type': EVIDENCE_MIME[ext] ?? 'application/octet-stream',
      'Content-Length': data.length,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    c.res.end(c.req.method === 'HEAD' ? undefined : data);
  });

  // 12. POST /api/context
  register('POST', '/api/context', async (c) => {
    sendOk(c.res, store.contextCreate(requireBody(c)), 201);
  });

  // 13. GET /api/context
  register('GET', '/api/context', async (c) => {
    sendOk(c.res, store.contextList({ q: c.query.get('q') ?? undefined, status: c.query.get('status') ?? undefined }));
  });

  // 14. GET /api/context/:entryId
  register('GET', '/api/context/:entryId', async (c) => {
    sendOk(c.res, store.contextGet(c.params.entryId));
  });

  return routes;
}

export function createCoreServer(store: Store, opts: CoreServerOptions): Server {
  const startedAt = Date.now();
  const routes = buildRoutes(store, startedAt, opts.version);
  const staticRoots = (opts.staticDirs ?? []).filter((d) => typeof d === 'string');

  return httpCreateServer((req, res) => {
    void handle(req, res).catch((err) => {
      if (!res.headersSent) sendError(req, res, err);
      else res.destroy(err);
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hostAllowed(req)) {
      const msg = `Host "${String(req.headers.host)}" not allowed: rma-core is a localhost-only service`;
      logRejection(req, 403, 'FORBIDDEN_HOST', msg);
      sendJson(res, 403, {
        ok: false,
        error: { code: 'FORBIDDEN_HOST', message: msg },
      });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathParts = url.pathname.split('/').filter(Boolean);
    const isApi = pathParts[0] === 'api';

    if (isApi) {
      applyCors(req, res);
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Content-Length': 0 });
        res.end();
        return;
      }
    }

    const method = req.method ?? 'GET';
    let body: unknown;
    if (method === 'POST') {
      body = await readJsonBody(req);
    }

    for (const route of routes) {
      if (route.method !== method || route.parts.length !== pathParts.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (let i = 0; i < route.parts.length; i++) {
        const rp = route.parts[i];
        const pp = pathParts[i];
        if (rp.startsWith(':')) params[rp.slice(1)] = decodeURIComponent(pp);
        else if (rp !== pp) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;
      try {
        await route.handler({ req, res, params, query: url.searchParams, body });
      } catch (err) {
        sendError(req, res, err);
      }
      return;
    }

    if (isApi) {
      const msg = `no such API route: ${method} ${url.pathname}`;
      logRejection(req, 404, 'NOT_FOUND', msg);
      sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: msg } });
      return;
    }

    if ((method === 'GET' || method === 'HEAD') && serveStatic(res, url.pathname, staticRoots, method === 'HEAD')) return;

    const msg = `not found: ${method} ${url.pathname}`;
    logRejection(req, 404, 'NOT_FOUND', msg);
    sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: msg } });
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > BODY_LIMIT_BYTES) throw new ApiError(400, 'BAD_REQUEST', `request body exceeds ${BODY_LIMIT_BYTES} bytes`);
    chunks.push(buf);
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, 'BAD_REQUEST', 'request body is not valid JSON');
  }
}
