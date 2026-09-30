// codex-bridge 작업 화면: Claude가 Codex에게 맡긴 작업을 브라우저에서 실시간으로 보여준다.
// Codex가 ~/.codex/sessions에 남기는 기록(rollout JSONL)을 읽기만 한다. 작업에는 영향을 주지 않는다.
// 화면 자체는 viewer.html 한 장이다.
// 여러 Claude 세션이 각자 브리지를 띄워도 기록 폴더가 같으므로, 포트를 먼저 잡은 브리지 하나가 전부 보여준다.

import http from 'node:http';
import { promises as fsp, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.CODEX_BRIDGE_VIEWER_PORT) || 4390;
const HOST = '127.0.0.1';
export const VIEWER_URL = `http://${HOST}:${PORT}/`;

const SESSIONS_DIR = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
const LIST_DAYS = 14;      // 목록에 올릴 기간
const LIST_MAX = 40;       // 목록 최대 개수
const TEXT_MAX = 6000;     // 명령 출력 등 긴 글 자르기
const STALL_MS = 15 * 60_000; // 작업 중인데 이만큼 새 기록이 없으면 멈춘 것으로 본다
const ACTIVITY_MAX = 160;  // "지금 하는 일" 한 줄 길이

const PAGE = readFileSync(new URL('./viewer.html', import.meta.url), 'utf8');

const cut = (s, n = TEXT_MAX) => {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + `\n… (${s.length - n}자 생략)` : s;
};
const joinText = (content) => (Array.isArray(content) ? content : [])
  .map((c) => c?.text ?? '').filter(Boolean).join('\n');
const firstLine = (s) => String(s ?? '').split('\n').find((l) => l.trim())?.trim() ?? '';
const isQuestion = (s) => /^\s*QUESTION:/m.test(s ?? '');

// 원본 도구 호출을 한 줄로: 코드 모드(exec) 안의 셸 명령이 있으면 그 명령을 보여준다
function describeCall(name, input) {
  const s = String(input ?? '');
  const arr = s.match(/"command"\s*:\s*(\[(?:[^\]"\\]|"(?:[^"\\]|\\.)*")*\])/);
  if (arr) { try { const a = JSON.parse(arr[1]); if (a.length) return String(a[a.length - 1]); } catch {} }
  // JSON 키("cmd":)와 코드 모드의 JS 객체 키(cmd:) 둘 다
  const m = s.match(/(?:^|[\s{,"])(?:command|cmd)"?\s*:\s*("(?:[^"\\]|\\.)*")/);
  if (m) { try { return JSON.parse(m[1]); } catch {} }
  const tools = [...new Set([...s.matchAll(/tools\.(\w+)\(/g)].map((x) => x[1]))];
  if (tools.length) return `${name}: ${tools.join(', ')}`;
  return `${name}: ${s.replace(/\s+/g, ' ').slice(0, 120)}`;
}

// ---------------------------------------------------------------------------
// 기록 파일 하나를 조금씩 읽어 화면용 이벤트로 바꾼다 (새로 붙은 줄만 읽음)
// ---------------------------------------------------------------------------
class Rollout {
  constructor(file) {
    this.file = file;
    this.offset = 0;
    this.rest = '';
    this.mtime = 0;
    this.events = [];
    this.meta = { id: null, cwd: '', originator: '', parentId: null, nickname: null, isGuardian: false };
    this.title = '';
    this.model = '';
    this.effort = '';
    this.sandbox = '';
    this.running = false;
    this.tokens = null;
    this.rateLimit = null;
    this.startedAt = null;
    this.updatedAt = null;
    this.pendingCalls = new Map(); // call_id -> 원본 도구 호출 (결과가 아직 없으면 실행 중)
    this.toolItems = 0;            // 정리된 도구 항목 수
    this.turns = 0;                // Claude가 보낸 지시(차례) 수
    this.turnStartedAt = null;
    this.lastDurationMs = null;
    this.endState = null;          // 마지막 차례가 끝난 방식: done | question | aborted | error
    this.endReason = '';
    this.turnError = null;
    this.lastAgentText = '';
    this.lastMessage = null;       // 목록 미리보기: { who: 'claude' | 'codex', text }
  }

  async refresh() {
    const st = await fsp.stat(this.file);
    if (st.mtimeMs === this.mtime && st.size === this.offset) return;
    this.mtime = st.mtimeMs;
    if (st.size < this.offset) { // 파일이 새로 쓰였으면 처음부터
      Object.assign(this, new Rollout(this.file));
      this.mtime = st.mtimeMs;
    }
    if (st.size === this.offset) return;
    const fh = await fsp.open(this.file, 'r');
    try {
      const buf = Buffer.alloc(st.size - this.offset);
      await fh.read(buf, 0, buf.length, this.offset);
      this.offset = st.size;
      const text = this.rest + buf.toString('utf8');
      const lines = text.split('\n');
      this.rest = lines.pop(); // 아직 다 안 쓰인 마지막 줄은 다음에
      for (const line of lines) {
        if (!line.trim()) continue;
        try { this.#take(JSON.parse(line)); } catch {}
      }
    } finally { await fh.close(); }
  }

  #push(ev, ts) { this.events.push({ ts, ...ev }); }

  #take(o) {
    const p = o.payload ?? {};
    const ts = o.timestamp;
    this.updatedAt = ts ?? this.updatedAt;
    if (o.type === 'session_meta') {
      const spawn = p.source?.subagent?.thread_spawn;
      this.meta = {
        id: p.id, cwd: p.cwd, originator: p.originator,
        parentId: spawn?.parent_thread_id ?? null,
        nickname: spawn ? (spawn.agent_nickname || String(spawn.agent_path ?? '').split('/').pop()) : null,
        isGuardian: p.source?.subagent?.other === 'guardian',
      };
      this.startedAt = p.timestamp ?? ts;
      return;
    }
    if (o.type === 'turn_context') {
      this.model = p.model ?? this.model;
      this.effort = p.effort ?? p.reasoning_effort ?? this.effort;
      this.sandbox = p.sandbox_policy?.type ?? this.sandbox;
      return;
    }
    if (o.type === 'event_msg') {
      if (p.type === 'task_started') {
        this.running = true;
        this.turns += 1;
        this.turnStartedAt = ts;
        this.endState = null;
        this.endReason = '';
        this.turnError = null;
        this.lastAgentText = '';
        this.pendingCalls.clear();
        this.#push({ kind: 'turn_start' }, ts);
      } else if (p.type === 'task_complete') {
        this.running = false;
        this.pendingCalls.clear();
        this.lastDurationMs = p.duration_ms ?? this.#sinceTurnStart(ts);
        const msg = p.last_agent_message ?? this.lastAgentText;
        if (!msg && this.turnError) {
          this.endState = 'error';
          this.endReason = this.turnError;
        } else {
          this.endState = isQuestion(msg) ? 'question' : 'done';
        }
        this.#push({ kind: 'turn_end', durationMs: this.lastDurationMs }, ts);
      } else if (p.type === 'turn_aborted') {
        this.running = false;
        this.pendingCalls.clear();
        this.lastDurationMs = this.#sinceTurnStart(ts);
        this.endState = 'aborted';
        this.endReason = p.reason ?? '';
        this.#push({ kind: 'turn_end', aborted: true, reason: p.reason ?? '', durationMs: this.lastDurationMs }, ts);
      } else if (p.type === 'token_count') {
        if (p.info?.total_token_usage) this.tokens = { ...p.info.total_token_usage, window: p.info.model_context_window };
        if (p.rate_limits?.primary) this.rateLimit = p.rate_limits.primary;
      } else if (p.type === 'error') {
        this.turnError = p.message ?? JSON.stringify(p);
        this.#push({ kind: 'error', text: this.turnError }, ts);
      } else if (p.type === 'item_completed') {
        this.#item(p.item ?? {}, ts);
      }
      return;
    }
    if (o.type === 'response_item') {
      if (p.type === 'compaction') {
        this.#push({ kind: 'note', text: '대화가 길어져 앞부분을 요약(압축)했습니다.' }, ts);
      } else if (p.type === 'custom_tool_call' || p.type === 'function_call') {
        this.pendingCalls.set(p.call_id, { name: p.name, input: p.input ?? p.arguments ?? '', items: this.toolItems });
      } else if (p.type === 'custom_tool_call_output' || p.type === 'function_call_output') {
        // 도구 호출 사이에 정리된 항목(명령 실행 등)이 기록되지 않은 경우에만 원본 호출을 보여준다 (옛 버전 기록 대비)
        const call = this.pendingCalls.get(p.call_id);
        this.pendingCalls.delete(p.call_id);
        if (!call || call.items !== this.toolItems) return;
        const out = typeof p.output === 'string' ? p.output : joinText(p.output) || JSON.stringify(p.output ?? '');
        this.#push({
          kind: 'command', title: describeCall(call.name, call.input),
          detail: cut(`${call.input}\n\n----- 결과 -----\n${out}`),
        }, ts);
      }
    }
  }

  #item(it, ts) {
    if (!['UserMessage', 'AgentMessage', 'Reasoning'].includes(it.type)) this.toolItems += 1;
    switch (it.type) {
      case 'UserMessage': {
        const text = joinText(it.content);
        if (!this.title) this.title = text.split('\n').find((l) => l.trim())?.trim().slice(0, 90) ?? '';
        this.lastMessage = { who: 'claude', text };
        return this.#push({ kind: 'manager', text }, ts);
      }
      case 'AgentMessage': {
        const text = joinText(it.content);
        this.lastAgentText = text;
        this.lastMessage = { who: 'codex', text };
        return this.#push({ kind: 'agent', phase: it.phase ?? '', text }, ts);
      }
      case 'Reasoning': {
        const summary = [...(it.summary_text ?? [])].join('\n').trim();
        return this.#push({ kind: 'reasoning', text: summary }, ts);
      }
      case 'CommandExecution': {
        const cmd = it.parsed_cmd?.map((c) => c.cmd).join(' && ')
          || (Array.isArray(it.command) ? it.command[it.command.length - 1] : it.command);
        const out = it.aggregated_output ?? [it.stdout, it.stderr].filter(Boolean).join('\n');
        return this.#push({
          kind: 'command', title: String(cmd ?? ''), status: it.status,
          exitCode: it.exit_code ?? it.exitCode ?? null, detail: cut(out),
        }, ts);
      }
      case 'FileChange': {
        const files = Object.entries(it.changes ?? {}).map(([f, c]) => ({ path: f, type: c?.type ?? 'update' }));
        const detail = Object.entries(it.changes ?? {})
          .map(([f, c]) => `### ${f} (${c?.type ?? 'update'})\n${c?.unified_diff ?? c?.content ?? ''}`).join('\n\n');
        return this.#push({ kind: 'files', files, status: it.status, detail: cut(detail) }, ts);
      }
      case 'McpToolCall': {
        const res = it.result?.content ? joinText(it.result.content) : JSON.stringify(it.result ?? it.error ?? '', null, 2);
        return this.#push({
          kind: 'tool', title: `${it.appName ?? it.server}.${it.actionName ?? it.tool}`, status: it.status,
          detail: cut(`인자: ${JSON.stringify(it.arguments ?? {}, null, 2)}\n\n결과:\n${res}`),
        }, ts);
      }
      case 'Extension': {
        if (it.kind === 'web.search') {
          const qs = it.action?.queries?.length ? it.action.queries : [it.query ?? it.action?.query].filter(Boolean);
          const results = (it.results ?? []).map((r) => `- ${r.title ?? ''}\n  ${r.url ?? ''}`).join('\n');
          return this.#push({ kind: 'search', title: qs.join(' · '), detail: cut(results) }, ts);
        }
        return this.#push({ kind: 'tool', title: it.kind ?? 'extension', detail: cut(JSON.stringify(it, null, 2)) }, ts);
      }
      default: {
        const saved = it.saved_path ?? it.savedPath;
        if (/image/i.test(it.type ?? '')) {
          return this.#push({ kind: 'image', title: saved ?? '이미지 생성', path: saved ?? null }, ts);
        }
        return this.#push({ kind: 'tool', title: it.type ?? '알 수 없는 항목', detail: cut(JSON.stringify(it, null, 2)) }, ts);
      }
    }
  }

  #sinceTurnStart(ts) {
    const ms = Date.parse(ts) - Date.parse(this.turnStartedAt);
    return Number.isFinite(ms) ? ms : null;
  }

  // 작업 중일 때 "지금 무엇을 하는지" 한 줄. 결과가 아직 안 온 도구 호출이 있으면 그걸 실행 중인 것이다.
  #activity() {
    const one = (s) => firstLine(s).slice(0, ACTIVITY_MAX);
    const calls = [...this.pendingCalls.values()];
    if (calls.length) {
      const c = calls[calls.length - 1];
      return { label: '명령 실행 중', detail: one(describeCall(c.name, c.input)) };
    }
    const last = this.events.findLast((e) => e.kind !== 'note' && e.kind !== 'error');
    switch (last?.kind) {
      case undefined: case 'turn_start': case 'manager':
        return { label: '지시를 읽고 계획하는 중', detail: '' };
      case 'reasoning': return { label: '생각하는 중', detail: one(last.text) };
      case 'agent': return { label: '중간 보고를 남기고 작업을 이어가는 중', detail: one(last.text) };
      case 'files': return { label: '파일을 고친 뒤 다음 단계를 생각하는 중', detail: one(last.files.map((f) => f.path).join(', ')) };
      default: return { label: '방금 한 일의 결과를 보고 다음 단계를 생각하는 중', detail: one(last.title) };
    }
  }

  #counts() {
    const c = { commands: 0, files: 0, searches: 0, tools: 0, images: 0 };
    for (const e of this.events) {
      if (e.kind === 'command') c.commands += 1;
      else if (e.kind === 'files') c.files += e.files.length;
      else if (e.kind === 'search') c.searches += 1;
      else if (e.kind === 'tool') c.tools += 1;
      else if (e.kind === 'image') c.images += 1;
    }
    return c;
  }

  summary() {
    const idleMs = this.updatedAt ? Date.now() - Date.parse(this.updatedAt) : 0;
    // running(작업 중) · stalled(멈춘 것 같음) · question(Claude 답변 대기) · done · aborted · error · idle
    const state = this.running ? (idleMs > STALL_MS ? 'stalled' : 'running') : (this.endState ?? 'idle');
    return {
      id: this.meta.id, title: this.title || '(제목 없음)', cwd: this.meta.cwd,
      parentId: this.meta.parentId, nickname: this.meta.nickname,
      model: this.model, effort: this.effort, sandbox: this.sandbox,
      state, running: this.running, activity: this.running ? this.#activity() : null,
      turns: this.turns, turnStartedAt: this.turnStartedAt, lastDurationMs: this.lastDurationMs, endReason: this.endReason,
      startedAt: this.startedAt, updatedAt: this.updatedAt, counts: this.#counts(),
      preview: this.lastMessage && { who: this.lastMessage.who, text: firstLine(this.lastMessage.text).slice(0, 120) },
      tokens: this.tokens, rateLimit: this.rateLimit, eventCount: this.events.length,
    };
  }
}

// ---------------------------------------------------------------------------
// 기록 폴더 훑기: codex-bridge가 시작한 작업만 (자동 검토용 guardian 스레드는 제외)
// ---------------------------------------------------------------------------
const rollouts = new Map(); // file -> Rollout
const firstLineCache = new Map(); // file -> meta or null

async function readFirstLine(file) {
  const fh = await fsp.open(file, 'r');
  try {
    let pos = 0, acc = '';
    const buf = Buffer.alloc(65536);
    while (pos < 4 * 1024 * 1024) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (!bytesRead) break;
      acc += buf.toString('utf8', 0, bytesRead);
      pos += bytesRead;
      const nl = acc.indexOf('\n');
      if (nl >= 0) return acc.slice(0, nl);
    }
    return acc;
  } finally { await fh.close(); }
}

async function isBridgeThread(file) {
  if (firstLineCache.has(file)) return firstLineCache.get(file);
  let ok = false;
  try {
    const p = JSON.parse(await readFirstLine(file)).payload ?? {};
    ok = p.originator === 'codex-bridge' && p.source?.subagent?.other !== 'guardian';
  } catch {}
  // 첫 줄이 아직 안 쓰인 새 파일은 다음에 다시 본다
  if (ok || Date.now() - (await fsp.stat(file)).mtimeMs > 60_000) firstLineCache.set(file, ok);
  return ok;
}

async function recentFiles() {
  const out = [];
  const now = new Date();
  for (let d = 0; d < LIST_DAYS; d++) {
    const day = new Date(now.getTime() - d * 86_400_000);
    const dir = path.join(SESSIONS_DIR, String(day.getFullYear()),
      String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
    let names = [];
    try { names = await fsp.readdir(dir); } catch { continue; }
    for (const n of names.filter((n) => n.endsWith('.jsonl')).sort().reverse()) out.push(path.join(dir, n));
  }
  return out;
}

async function listThreads() {
  const result = [];
  for (const file of await recentFiles()) {
    if (result.length >= LIST_MAX) break;
    if (!(await isBridgeThread(file))) continue;
    let r = rollouts.get(file);
    if (!r) { r = new Rollout(file); rollouts.set(file, r); }
    try { await r.refresh(); } catch { continue; }
    result.push(r.summary());
  }
  return result;
}

async function findThread(id) {
  for (const r of rollouts.values()) if (r.meta.id === id) return r;
  await listThreads();
  for (const r of rollouts.values()) if (r.meta.id === id) return r;
  return null;
}

// ---------------------------------------------------------------------------
// HTTP 서버
// ---------------------------------------------------------------------------
function sendJson(res, obj) {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

async function handle(req, res) {
  const url = new URL(req.url, VIEWER_URL);
  try {
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(PAGE);
    }
    const asset = url.pathname.match(/^\/assets\/([\w-]+\.png)$/);
    if (asset) {
      const body = await fsp.readFile(new URL(`./assets/${asset[1]}`, import.meta.url)).catch(() => null);
      if (!body) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=3600' });
      return res.end(body);
    }
    if (url.pathname === '/api/threads') return sendJson(res, { threads: await listThreads() });
    const m = url.pathname.match(/^\/api\/thread\/([\w-]+)$/);
    if (m) {
      const r = await findThread(m[1]);
      if (!r) { res.writeHead(404); return res.end('not found'); }
      await r.refresh();
      const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
      return sendJson(res, { summary: r.summary(), since, events: r.events.slice(since) });
    }
    res.writeHead(404); res.end('not found');
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(String(e?.message ?? e));
  }
}

// 포트를 이미 다른 브리지가 쓰고 있으면 조용히 물러났다가, 그 브리지가 꺼지면 이어받는다.
export function startViewer() {
  const server = http.createServer((req, res) => { handle(req, res); });
  let retry = null;
  const listen = () => server.listen(PORT, HOST);
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') { retry = setTimeout(listen, 30_000); retry.unref(); }
  });
  listen();
  server.unref();
  return server;
}

// 단독 실행: node viewer.mjs
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const s = startViewer();
  s.ref();
  s.on('listening', () => console.log(`작업 화면: ${VIEWER_URL}`));
}
