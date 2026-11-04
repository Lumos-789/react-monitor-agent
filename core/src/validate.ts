// 输入校验与证据归一化(dataB64 → 落盘 → path+url)。从 store 拆出的无状态/薄 IO 部分。
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { extname, join } from 'node:path';
import { ApiError } from './errors.js';
import type { Evidence } from './types.js';

const EXT_RE = /^[a-z0-9]{1,8}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const EVIDENCE_MAX_BYTES = 2 * 1024 * 1024;

export function iso(): string {
  return new Date().toISOString();
}

export function rand6(): string {
  return randomBytes(8).toString('hex').slice(0, 6);
}

export function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export function assertString(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new ApiError(400, 'BAD_REQUEST', `field "${name}" must be a non-empty string`);
  }
  return v;
}

export function optString(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new ApiError(400, 'BAD_REQUEST', 'optional field must be a string when present');
  return v;
}

export function assertEnum<T extends string>(v: unknown, allowed: readonly T[], name: string): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    throw new ApiError(400, 'BAD_REQUEST', `field "${name}" must be one of ${allowed.join(', ')}`);
  }
  return v as T;
}

export function assertStringArray(v: unknown, name: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new ApiError(400, 'BAD_REQUEST', `field "${name}" must be an array of strings`);
  }
  return v as string[];
}

/** 证据归一化:image/file 的 dataB64 输入 → 落盘 evidence/<fileId>.<ext>,事件里只留 path+url。 */
export class EvidenceNormalizer {
  constructor(private readonly worksDir: string) {}

  list(workId: string, input: unknown, name: string): Evidence[] {
    if (input === undefined || input === null) {
      throw new ApiError(400, 'BAD_REQUEST', `field "${name}" is required`);
    }
    if (!Array.isArray(input)) throw new ApiError(400, 'BAD_REQUEST', `field "${name}" must be an array`);
    return input.map((e, i) => this.one(workId, e, `${name}[${i}]`));
  }

  one(workId: string, raw: unknown, name: string): Evidence {
    if (!raw || typeof raw !== 'object') throw new ApiError(400, 'BAD_REQUEST', `${name} must be an object`);
    const e = raw as Record<string, unknown>;
    const caption = optString(e.caption);
    switch (e.kind) {
      case 'text':
      case 'code_diff':
        return { kind: e.kind, text: assertString(e.text, `${name}.text`) };
      case 'link': {
        const url = assertString(e.url, `${name}.url`);
        const out: Evidence = { kind: 'link', url };
        if (caption !== undefined) out.caption = caption;
        return out;
      }
      case 'image':
      case 'file':
        return this.file(workId, e, name, caption);
      default:
        throw new ApiError(400, 'BAD_REQUEST', `${name}: unknown evidence kind ${JSON.stringify(e.kind)}`);
    }
  }

  private file(workId: string, e: Record<string, unknown>, name: string, caption: string | undefined): Evidence {
    if (typeof e.dataB64 === 'string') {
      const b64 = e.dataB64.replace(/\s+/g, '');
      if (!B64_RE.test(b64)) throw new ApiError(400, 'BAD_REQUEST', `${name}.dataB64 is not valid base64`);
      const buf = Buffer.from(b64, 'base64');
      if (buf.length === 0) throw new ApiError(400, 'BAD_REQUEST', `${name}.dataB64 decoded to an empty payload`);
      if (buf.length > EVIDENCE_MAX_BYTES) {
        throw new ApiError(400, 'BAD_REQUEST', `${name}.dataB64 exceeds the 2MB evidence limit (${buf.length} bytes)`);
      }
      const filenameExt = typeof e.filename === 'string' ? extname(e.filename).slice(1).toLowerCase() : '';
      const ext = EXT_RE.test(filenameExt) ? filenameExt : e.kind === 'image' ? 'png' : 'bin';
      const fileId = rand6();
      const dir = join(this.worksDir, workId, 'evidence');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${fileId}.${ext}`), buf);
      const out: Evidence = { kind: e.kind as 'image' | 'file', path: `evidence/${fileId}.${ext}`, url: `/api/works/${workId}/evidence/${fileId}` };
      if (caption !== undefined) out.caption = caption;
      return out;
    }
    if (typeof e.path === 'string' && typeof e.url === 'string') {
      const out: Evidence = { kind: e.kind as 'image' | 'file', path: e.path, url: e.url };
      if (caption !== undefined) out.caption = caption;
      return out;
    }
    throw new ApiError(400, 'BAD_REQUEST', `${name}: image/file evidence requires dataB64 (upload) or path+url (already normalized)`);
  }
}
