// store —— JSONL/JSON 落盘、启动重建、检查点/决策/分支推进、inbox 长轮询(tech-design §4)。
// 唯一事实源是 works/<workId>/timeline.jsonl;works.json 是可重建的物化缓存(原子写)。
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { ApiError } from './errors.js';
import { nextBranchId, statusAfterDecision, validateDecisionInput } from './domain.js';
import { fold, type Folded } from './fold.js';
import { EvidenceNormalizer, assertEnum, assertString, assertStringArray, clone, iso, optString, rand6 } from './validate.js';
import {
  CHECKPOINT_TYPES,
  WORK_STATUSES,
  WORK_TRACKS,
  type BranchInfo,
  type Checkpoint,
  type ContextEntry,
  type Decision,
  type TimelineEvent,
  type WorkItem,
  type WorkStatus,
  type WorkTrack,
} from './types.js';

const WORK_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FILE_ID_RE = /^[a-z0-9]{1,32}$/;

interface WorkState {
  events: TimelineEvent[];
  folded: Folded;
}

export interface CreateWorkInput {
  id?: string;
  track: WorkTrack;
  kind: string;
  title: string;
  agent: string;
  template?: string;
}

function agentActor(work: WorkItem): string {
  return `agent:${work.agent}`;
}

function appendLine(file: string, obj: unknown): void {
  appendFileSync(file, JSON.stringify(obj) + '\n');
}

function atomicWrite(file: string, data: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

export class Store {
  readonly home: string;
  private readonly worksDir: string;
  private readonly contextFile: string;
  private readonly snapshotFile: string;
  private works = new Map<string, WorkState>();
  private context = new Map<string, ContextEntry>();
  private waiterSeq = 0;
  private inboxWaiters = new Map<number, { workId: string; fire: () => void }>();
  private readonly evidence: EvidenceNormalizer;

  constructor(home: string) {
    this.home = home;
    this.worksDir = join(home, 'works');
    this.contextFile = join(home, 'context', 'entries.jsonl');
    this.snapshotFile = join(home, 'works.json');
    this.evidence = new EvidenceNormalizer(this.worksDir);
    mkdirSync(this.worksDir, { recursive: true });
    mkdirSync(join(home, 'context'), { recursive: true });
    this.load();
  }

  // ── 加载与重建 ────────────────────────────────────────────────

  private timelineFile(workId: string): string {
    return join(this.worksDir, workId, 'timeline.jsonl');
  }

  /** 读 JSONL:末行解析失败 = torn write → 截断该行并 fail-loud 打日志;更早行损坏 → 抛错。 */
  private readJsonl(file: string): unknown[] {
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    const out: unknown[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      try {
        out.push(JSON.parse(line));
      } catch (err) {
        if (i === lines.length - 1) {
          console.error(`[rma-core] fail-loud: torn write detected, truncating last line of ${file}: ${line.slice(0, 120)}`);
          writeFileSync(file, lines.slice(0, i).join('\n') + (i > 0 ? '\n' : ''));
          break;
        }
        throw new Error(`store: corrupt JSONL ${file} at line ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return out;
  }

  private load(): void {
    for (const dir of readdirSync(this.worksDir, { withFileTypes: true })) {
      if (!dir.isDirectory() || !WORK_ID_RE.test(dir.name)) continue;
      const file = this.timelineFile(dir.name);
      if (!existsSync(file)) continue;
      const events = this.readJsonl(file) as TimelineEvent[];
      if (events.length === 0) continue;
      const first = events[0];
      if (!first || first.type !== 'work.created' || first.workId !== dir.name || first.work?.id !== dir.name) {
        throw new Error(`store: ${file} does not start with a work.created event matching work id "${dir.name}"`);
      }
      // fold 同时校验「同时至多一个 open 检查点」invariant(违则启动 fail-loud)
      this.works.set(dir.name, { events, folded: fold(events) });
    }
    if (existsSync(this.contextFile)) {
      for (const raw of this.readJsonl(this.contextFile)) {
        const entry = raw as ContextEntry;
        if (!entry || typeof entry.id !== 'string') {
          throw new Error(`store: corrupt context entry in ${this.contextFile}`);
        }
        this.context.set(entry.id, entry); // 后写覆盖(last-write-wins)
      }
    }
    this.refreshSnapshot();
  }

  private buildSnapshot(): { version: number; generatedAt: string; works: WorkItem[]; contextEntries: ContextEntry[] } {
    return {
      version: 1,
      generatedAt: iso(),
      works: [...this.works.values()].map((w) => w.folded.work),
      contextEntries: [...this.context.values()],
    };
  }

  private writeSnapshot(): void {
    atomicWrite(this.snapshotFile, JSON.stringify(this.buildSnapshot(), null, 2) + '\n');
  }

  /** works.json 缺失/损坏/与 fold 结果不一致 → 重写(tech-design §4 规则3) */
  private refreshSnapshot(): void {
    const canonical = JSON.stringify(this.buildSnapshot(), null, 2) + '\n';
    let current: string | null = null;
    if (existsSync(this.snapshotFile)) {
      try {
        current = readFileSync(this.snapshotFile, 'utf8');
      } catch {
        current = null;
      }
      if (current !== null && current !== canonical) {
        console.error(`[rma-core] works.json 缺失/损坏/过期,已按 timeline fold 结果重建:${this.snapshotFile}`);
      }
    }
    if (current !== canonical) this.writeSnapshot();
  }

  reload(): void {
    this.works = new Map();
    this.context = new Map();
    this.load();
  }

  // ── 读路径 ────────────────────────────────────────────────────

  worksCount(): number {
    return this.works.size;
  }

  listWorks(filter: { track?: string; status?: string }): WorkItem[] {
    const track = filter.track === undefined ? undefined : assertEnum<WorkTrack>(filter.track, WORK_TRACKS, 'track');
    const status = filter.status === undefined ? undefined : assertEnum<WorkStatus>(filter.status, WORK_STATUSES, 'status');
    return [...this.works.values()]
      .map((w) => clone(w.folded.work))
      .filter((w) => (track === undefined || w.track === track) && (status === undefined || w.status === status))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id.localeCompare(b.id)));
  }

  private requireWork(workId: string): WorkState {
    const ws = this.works.get(workId);
    if (!ws) throw new ApiError(404, 'NOT_FOUND', `work ${workId} not found`);
    return ws;
  }

  getWork(workId: string): { work: WorkItem; openCheckpointId: string | null } {
    const ws = this.requireWork(workId);
    const open = ws.folded.checkpoints.find((c) => c.status === 'open');
    return { work: clone(ws.folded.work), openCheckpointId: open ? open.id : null };
  }

  timeline(workId: string, sinceSeq: number): { work: WorkItem; events: TimelineEvent[]; checkpoints: Checkpoint[]; decisions: Decision[]; branches: BranchInfo[] } {
    const ws = this.requireWork(workId);
    return {
      work: clone(ws.folded.work),
      events: ws.events.filter((e) => e.seq > sinceSeq).map((e) => clone(e)),
      checkpoints: clone(ws.folded.checkpoints),
      decisions: clone(ws.folded.decisions),
      branches: clone(ws.folded.branches),
    };
  }

  findCheckpoint(checkpointId: string): { ws: WorkState; checkpoint: Checkpoint } | undefined {
    for (const ws of this.works.values()) {
      const cp = ws.folded.checkpoints.find((c) => c.id === checkpointId);
      if (cp) return { ws, checkpoint: cp };
    }
    return undefined;
  }

  findDecision(decisionId: string): { ws: WorkState; decision: Decision } | undefined {
    for (const ws of this.works.values()) {
      const d = ws.folded.decisions.find((x) => x.id === decisionId);
      if (d) return { ws, decision: d };
    }
    return undefined;
  }

  /** 决策回注:未消费决策按事件 seq 升序;wait=N(≤60s)长轮询(tech-design §2.2) */
  async inbox(workId: string, wait: number): Promise<Decision[]> {
    const ws = this.requireWork(workId);
    const deadline = Date.now() + wait * 1000;
    for (;;) {
      const pending = ws.folded.decisions.filter((d) => d.consumedAt == null);
      if (pending.length > 0 || wait <= 0 || Date.now() >= deadline) {
        return pending.map((d) => clone(d));
      }
      await this.waitForDecision(workId, Math.min(250, deadline - Date.now()));
    }
  }

  private waitForDecision(workId: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const key = ++this.waiterSeq;
      const timer = setTimeout(() => {
        this.inboxWaiters.delete(key);
        resolve();
      }, Math.max(ms, 1));
      this.inboxWaiters.set(key, {
        workId,
        fire: () => {
          clearTimeout(timer);
          this.inboxWaiters.delete(key);
          resolve();
        },
      });
    });
  }

  private notifyInboxWaiters(workId: string): void {
    for (const w of this.inboxWaiters.values()) if (w.workId === workId) w.fire();
  }

  // ── 写路径:work / 事件 / 检查点 / 决策 ─────────────────────────

  private nextSeq(ws: WorkState): number {
    return ws.folded.work.lastSeq + 1;
  }

  private mkEvent<T extends Record<string, unknown>>(ws: WorkState, type: TimelineEvent['type'], actor: string, fields: T): TimelineEvent {
    const workId = ws.folded.work.id;
    const seq = this.nextSeq(ws);
    return {
      id: `ev-${workId}-${seq}`,
      workId,
      seq,
      ts: iso(),
      branch: ws.folded.work.activeBranch,
      type,
      actor,
      ...fields,
    } as unknown as TimelineEvent;
  }

  /** 追加一行 + 内存重放(每次 append 全量 fold,顺带重校验 invariant)+ 快照重写。 */
  private commit(ws: WorkState, ev: TimelineEvent): void {
    appendLine(this.timelineFile(ws.folded.work.id), ev);
    ws.events.push(ev);
    ws.folded = fold(ws.events);
    this.writeSnapshot();
    if (ev.type === 'decision.made') this.notifyInboxWaiters(ev.workId);
  }

  createWork(input: {
    id?: unknown;
    track?: unknown;
    kind?: unknown;
    title?: unknown;
    agent?: unknown;
    template?: unknown;
  }): { work: WorkItem; replay: boolean } {
    const track = assertEnum<WorkTrack>(input.track, WORK_TRACKS, 'track');
    const kind = assertString(input.kind, 'kind');
    const title = assertString(input.title, 'title');
    const agent = assertString(input.agent, 'agent');
    const template = optString(input.template);

    const id = input.id === undefined || input.id === null ? `w-${rand6()}` : assertString(input.id, 'id');
    if (!WORK_ID_RE.test(id)) {
      throw new ApiError(400, 'BAD_REQUEST', `invalid work id "${id}" (must match ${WORK_ID_RE})`);
    }

    const existing = this.works.get(id);
    if (existing) {
      const w = existing.folded.work;
      const same =
        w.track === track && w.kind === kind && w.title === title && w.agent === agent && (w.template ?? null) === (template ?? null);
      if (!same) throw new ApiError(409, 'ID_EXISTS', `work ${id} already exists with different parameters`);
      return { work: clone(w), replay: true };
    }

    const now = iso();
    const work: WorkItem = {
      id,
      track,
      kind,
      title,
      agent,
      status: 'active',
      activeBranch: 'main',
      createdAt: now,
      updatedAt: now,
      lastSeq: 1,
    };
    if (template !== undefined) work.template = template;

    const ev: TimelineEvent = {
      id: `ev-${id}-1`,
      workId: id,
      seq: 1,
      ts: now,
      branch: 'main',
      type: 'work.created',
      actor: `agent:${agent}`,
      work,
    };
    const ws: WorkState = { events: [ev], folded: fold([ev]) };
    mkdirSync(join(this.worksDir, id), { recursive: true });
    appendLine(this.timelineFile(id), ev);
    this.works.set(id, ws);
    this.writeSnapshot();
    return { work: clone(ws.folded.work), replay: false };
  }

  postEvent(workId: string, body: Record<string, unknown>): TimelineEvent {
    const ws = this.requireWork(workId);
    const actor = agentActor(ws.folded.work);
    const type = body.type;
    let ev: TimelineEvent;
    switch (type) {
      case 'note': {
        const text = assertString(body.text, 'text');
        const evidence = body.evidence === undefined ? undefined : this.evidence.list(workId, body.evidence, 'evidence');
        ev = this.mkEvent(ws, 'note', actor, evidence === undefined ? { text } : { text, evidence });
        break;
      }
      case 'artifact': {
        const title = assertString(body.title, 'title');
        const evidence = this.evidence.list(workId, body.evidence, 'evidence');
        ev = this.mkEvent(ws, 'artifact', actor, { title, evidence });
        break;
      }
      case 'tool': {
        const tool = assertString(body.tool, 'tool');
        const summary = assertString(body.summary, 'summary');
        ev = this.mkEvent(ws, 'tool', actor, { tool, summary });
        break;
      }
      case 'context.consumed': {
        const entryIds = assertStringArray(body.entryIds, 'entryIds');
        ev = this.mkEvent(ws, 'context.consumed', actor, { entryIds });
        break;
      }
      case 'context.proposed': {
        if (!body.entry || typeof body.entry !== 'object') {
          throw new ApiError(400, 'BAD_REQUEST', 'field "entry" must be an object for context.proposed');
        }
        const entry = this.materializeProposedEntry(workId, body.entry as Record<string, unknown>);
        ev = this.mkEvent(ws, 'context.proposed', actor, { entry });
        break;
      }
      case 'work.status': {
        if (body.status !== 'abandoned') {
          throw new ApiError(400, 'BAD_REQUEST', `work.status event only accepts status='abandoned' (got ${JSON.stringify(body.status)})`);
        }
        const reason = optString(body.reason);
        ev = this.mkEvent(ws, 'work.status', actor, reason === undefined ? { status: 'abandoned' as const } : { status: 'abandoned' as const, reason });
        break;
      }
      default:
        throw new ApiError(
          400,
          'BAD_REQUEST',
          `unsupported event type ${JSON.stringify(type)} (allowed: note, artifact, tool, context.consumed, context.proposed, work.status)`,
        );
    }
    this.commit(ws, ev);
    return clone(ev);
  }

  raiseCheckpoint(workId: string, body: Record<string, unknown>): Checkpoint {
    const ws = this.requireWork(workId);
    const open = ws.folded.checkpoints.find((c) => c.status === 'open');
    if (open) {
      throw new ApiError(409, 'CHECKPOINT_OPEN', `work ${workId} already has an open checkpoint (${open.id}); at most one open checkpoint at a time`);
    }
    const type = assertEnum<Checkpoint['type']>(body.type, CHECKPOINT_TYPES, 'type');
    const origin =
      body.origin === undefined ? 'agent' : assertEnum<Checkpoint['origin']>(body.origin, ['template', 'agent'], 'origin');
    const title = assertString(body.title, 'title');
    const cpBody = optString(body.body) ?? '';
    const evidence = body.evidence === undefined ? [] : this.evidence.list(workId, body.evidence, 'evidence');

    const seq = this.nextSeq(ws);
    const cp: Checkpoint = {
      id: `cp-${workId}-${seq}`,
      workId,
      type,
      origin,
      title,
      body: cpBody,
      evidence,
      raisedAt: iso(),
      raisedBy: ws.folded.work.agent,
      status: 'open',
    };
    this.commit(ws, this.mkEvent(ws, 'checkpoint.raised', agentActor(ws.folded.work), { checkpoint: cp }));
    this.commit(ws, this.mkEvent(ws, 'work.status', 'core', { status: 'waiting' as WorkStatus, reason: `checkpoint ${cp.id} open` }));
    return clone(cp);
  }

  decide(checkpointId: string, body: Record<string, unknown>): Decision {
    const found = this.findCheckpoint(checkpointId);
    if (!found) throw new ApiError(404, 'NOT_FOUND', `checkpoint ${checkpointId} not found`);
    const { ws, checkpoint: cp } = found;
    if (cp.status !== 'open') {
      throw new ApiError(409, 'ALREADY_RESOLVED', `checkpoint ${cp.id} is already ${cp.status}`);
    }
    const text = optString(body.text);
    const action = validateDecisionInput(cp, body.action, text);
    const workId = ws.folded.work.id;
    const attachments =
      body.attachments === undefined ? undefined : this.evidence.list(workId, body.attachments, 'attachments');

    const seq = this.nextSeq(ws);
    const decision: Decision = {
      id: `dec-${workId}-${seq}`,
      workId,
      checkpointId: cp.id,
      action,
      actor: 'human',
      createdAt: iso(),
      consumedAt: null,
    };
    if (text !== undefined) decision.text = text;
    if (attachments !== undefined) decision.attachments = attachments;

    const fields: Record<string, unknown> = { decision };
    if (action === 'reject' || action === 'redirect') {
      // 否定/改向:旧分支 closed 留痕(灰掉),新分支挂 alt(tech-design §1.1 规则3)
      fields.branchClosed = ws.folded.work.activeBranch;
      fields.branchOpened = nextBranchId(ws.folded.branches);
    }
    this.commit(ws, this.mkEvent(ws, 'decision.made', 'human', fields));

    const nextStatus = statusAfterDecision(action);
    if (nextStatus !== null) {
      const reason = action === 'deliver' ? `delivered by ${decision.id}` : `checkpoint resolved: ${action}`;
      this.commit(ws, this.mkEvent(ws, 'work.status', 'core', { status: nextStatus, reason }));
    }
    if (action === 'deliver') this.acceptContextForWork(workId);

    const foldedDecision = ws.folded.decisions.find((d) => d.id === decision.id);
    if (!foldedDecision) throw new Error('store: decision vanished after commit (internal inconsistency)');
    return clone(foldedDecision);
  }

  /** 幂等 ack:重复 ack 200 不重复记事件(tech-design §2.1 端点10) */
  ackDecision(decisionId: string): Decision {
    const found = this.findDecision(decisionId);
    if (!found) throw new ApiError(404, 'NOT_FOUND', `decision ${decisionId} not found`);
    const { ws, decision } = found;
    if (decision.consumedAt == null) {
      this.commit(ws, this.mkEvent(ws, 'decision.acked', agentActor(ws.folded.work), { decisionId }));
    }
    const foldedDecision = ws.folded.decisions.find((d) => d.id === decisionId);
    if (!foldedDecision) throw new Error('store: decision vanished after ack (internal inconsistency)');
    return clone(foldedDecision);
  }

  // ── Context Track ────────────────────────────────────────────

  /** deliver 时:该 work 名下 draft 条目翻 accepted(入库=人审过);context.proposed 同理联动。 */
  private acceptContextForWork(workId: string): void {
    for (const entry of this.context.values()) {
      if (entry.sourceWorkId === workId && entry.status === 'draft') {
        this.appendContextEntry({ ...clone(entry), status: 'accepted', updatedAt: iso() });
      }
    }
  }

  private appendContextEntry(entry: ContextEntry): void {
    const existing = this.context.get(entry.id);
    if (existing && JSON.stringify(existing) === JSON.stringify(entry)) return;
    appendLine(this.contextFile, entry);
    this.context.set(entry.id, clone(entry));
    this.writeSnapshot();
  }

  contextCreate(body: Record<string, unknown>): ContextEntry {
    const title = assertString(body.title, 'title');
    const content = assertString(body.content, 'content');
    const kind = optString(body.kind) ?? 'knowledge';
    const tags = body.tags === undefined ? [] : assertStringArray(body.tags, 'tags');
    const sourceWorkId = optString(body.sourceWorkId);
    if (sourceWorkId !== undefined) this.requireWork(sourceWorkId);
    const now = iso();
    const entry: ContextEntry = { id: `ctx-${rand6()}`, title, kind, tags, content, status: 'draft', createdAt: now, updatedAt: now };
    if (sourceWorkId !== undefined) entry.sourceWorkId = sourceWorkId;
    this.appendContextEntry(entry);
    return clone(entry);
  }

  /** POST /works/:id/events 收到 context.proposed 时物化成 draft 条目(接受外部 id,fixture 灌入复用) */
  private materializeProposedEntry(workId: string, input: Record<string, unknown>): ContextEntry {
    const title = assertString(input.title, 'entry.title');
    const content = assertString(input.content, 'entry.content');
    const kind = optString(input.kind) ?? 'knowledge';
    const tags = input.tags === undefined ? [] : assertStringArray(input.tags, 'entry.tags');
    const id = input.id === undefined || input.id === null ? `ctx-${rand6()}` : assertString(input.id, 'entry.id');
    const now = iso();
    const entry: ContextEntry = { id, title, kind, tags, content, status: 'draft', sourceWorkId: workId, createdAt: now, updatedAt: now };
    this.appendContextEntry(entry);
    return entry;
  }

  contextList(filter: { q?: string; status?: string }): ContextEntry[] {
    let status: ContextEntry['status'] | undefined;
    if (filter.status !== undefined) {
      status = assertEnum<ContextEntry['status']>(filter.status, ['draft', 'accepted'], 'status');
    }
    const q = filter.q === undefined ? undefined : filter.q.toLowerCase();
    return [...this.context.values()]
      .filter((e) => status === undefined || e.status === status)
      .filter((e) => {
        if (q === undefined) return true;
        return e.title.toLowerCase().includes(q) || e.tags.some((t) => t.toLowerCase().includes(q));
      })
      .map((e) => clone(e));
  }

  contextGet(entryId: string): ContextEntry {
    const entry = this.context.get(entryId);
    if (!entry) throw new ApiError(404, 'NOT_FOUND', `context entry ${entryId} not found`);
    return clone(entry);
  }

  // ── 证据文件 ─────────────────────────────────────────────────

  findEvidence(workId: string, fileId: string): { absPath: string; ext: string } {
    this.requireWork(workId);
    if (!FILE_ID_RE.test(fileId)) throw new ApiError(400, 'BAD_REQUEST', `invalid evidence file id "${fileId}"`);
    const dir = join(this.worksDir, workId, 'evidence');
    if (!existsSync(dir)) throw new ApiError(404, 'NOT_FOUND', `evidence ${fileId} not found`);
    const match = readdirSync(dir).find((n) => n.startsWith(`${fileId}.`));
    if (!match) throw new ApiError(404, 'NOT_FOUND', `evidence ${fileId} not found`);
    return { absPath: join(dir, match), ext: extname(match).slice(1).toLowerCase() };
  }

  // ── fixture 灌入(seed) ────────────────────────────────────────

  /** 把一段已有事件流(来自 JSONL fixture)原样写入 store;已存在的 work 跳过。 */
  ingestWorkEvents(workId: string, events: TimelineEvent[]): void {
    if (this.works.has(workId)) {
      console.error(`[rma-core] seed: work ${workId} already exists, skipping`);
      return;
    }
    const first = events[0];
    if (!first || first.type !== 'work.created' || first.workId !== workId || first.work?.id !== workId) {
      throw new Error(`seed: event stream for ${workId} must start with a matching work.created event`);
    }
    const file = this.timelineFile(workId);
    mkdirSync(join(this.worksDir, workId), { recursive: true });
    for (const ev of events) appendLine(file, ev);
    const ws: WorkState = { events: [...events], folded: fold(events) };
    this.works.set(workId, ws);
    for (const ev of events) {
      if (ev.type === 'context.proposed') this.appendContextEntry(clone(ev.entry));
    }
    this.writeSnapshot();
  }
}
