// codex-bridge 작업 화면: Claude가 Codex에게 맡긴 작업을 브라우저에서 실시간으로 보여준다.
// Codex가 ~/.codex/sessions에 남기는 기록(rollout JSONL)을 읽기만 한다. 작업에는 영향을 주지 않는다.
// 여러 Claude 세션이 각자 브리지를 띄워도 기록 폴더가 같으므로, 포트를 먼저 잡은 브리지 하나가 전부 보여준다.

import http from 'node:http';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.CODEX_BRIDGE_VIEWER_PORT) || 4390;
const HOST = '127.0.0.1';
export const VIEWER_URL = `http://${HOST}:${PORT}/`;

const SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');
const LIST_DAYS = 14;      // 목록에 올릴 기간
const LIST_MAX = 40;       // 목록 최대 개수
const TEXT_MAX = 6000;     // 명령 출력 등 긴 글 자르기

const cut = (s, n = TEXT_MAX) => {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + `\n… (${s.length - n}자 생략)` : s;
};
const joinText = (content) => (Array.isArray(content) ? content : [])
  .map((c) => c?.text ?? '').filter(Boolean).join('\n');

// 원본 도구 호출을 한 줄로: 코드 모드(exec) 안의 셸 명령이 있으면 그 명령을 보여준다
function describeCall(name, input) {
  const s = String(input ?? '');
  const m = s.match(/"(?:command|cmd)"\s*:\s*("(?:[^"\\]|\\.)*")/);
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
    this.pendingCalls = new Map(); // call_id -> 원본 도구 호출
    this.toolItems = 0;            // 정리된 도구 항목 수
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
        this.#push({ kind: 'turn_start' }, ts);
      } else if (p.type === 'task_complete') {
        this.running = false;
        this.#push({ kind: 'turn_end', durationMs: p.duration_ms ?? null }, ts);
      } else if (p.type === 'turn_aborted') {
        this.running = false;
        this.#push({ kind: 'turn_end', aborted: true, reason: p.reason ?? '' }, ts);
      } else if (p.type === 'token_count') {
        if (p.info?.total_token_usage) this.tokens = { ...p.info.total_token_usage, window: p.info.model_context_window };
        if (p.rate_limits?.primary) this.rateLimit = p.rate_limits.primary;
      } else if (p.type === 'error') {
        this.#push({ kind: 'error', text: p.message ?? JSON.stringify(p) }, ts);
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
        return this.#push({ kind: 'manager', text }, ts);
      }
      case 'AgentMessage':
        return this.#push({ kind: 'agent', phase: it.phase ?? '', text: joinText(it.content) }, ts);
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

  summary() {
    return {
      id: this.meta.id, title: this.title || '(제목 없음)', cwd: this.meta.cwd,
      parentId: this.meta.parentId, nickname: this.meta.nickname,
      model: this.model, effort: this.effort, sandbox: this.sandbox,
      running: this.running, startedAt: this.startedAt, updatedAt: this.updatedAt,
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

// ---------------------------------------------------------------------------
// 화면 (HTML 한 장)
// ---------------------------------------------------------------------------
const PAGE = /* html */ `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Codex 작업 보기</title>
<style>
:root {
  --bg: #f6f7f9; --panel: #ffffff; --line: #e3e6eb; --text: #1d2330; --muted: #6b7382;
  --claude: #c8643b; --claude-bg: #fbefe9; --codex: #1f6f8b; --codex-bg: #e8f3f7;
  --final-bg: #eaf6ee; --final: #2e7d4f; --err: #b3261e; --err-bg: #fdecea;
  --chip: #eef0f4; --run: #1f8f5a; --mono: ui-monospace, "Cascadia Code", Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14171c; --panel: #1b1f26; --line: #2b313b; --text: #e4e7ec; --muted: #9098a6;
    --claude: #e79068; --claude-bg: #2e221c; --codex: #6cc3e0; --codex-bg: #18282f;
    --final-bg: #17291f; --final: #6fd29a; --err: #ff8a80; --err-bg: #331c1a;
    --chip: #262b34; --run: #4cd08c;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body { background: var(--bg); color: var(--text); font: 14px/1.55 system-ui, "Segoe UI", "Malgun Gothic", sans-serif; }
.app { display: grid; grid-template-columns: 300px 1fr; height: 100vh; }
aside { border-right: 1px solid var(--line); background: var(--panel); overflow-y: auto; }
aside header { padding: 14px 16px 10px; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--panel); z-index: 1; }
aside h1 { font-size: 15px; margin: 0 0 6px; }
.follow { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); cursor: pointer; }
.thread { padding: 10px 16px; border-bottom: 1px solid var(--line); cursor: pointer; }
.thread:hover { background: var(--chip); }
.thread.active { background: var(--codex-bg); }
.thread.child { padding-left: 32px; }
.thread .t { font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.thread .s { font-size: 12px; color: var(--muted); display: flex; gap: 6px; align-items: center; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex: none; }
.dot.run { background: var(--run); animation: pulse 1.2s infinite; }
@keyframes pulse { 50% { opacity: .35; } }
main { display: flex; flex-direction: column; min-width: 0; height: 100vh; }
.top { padding: 12px 20px; border-bottom: 1px solid var(--line); background: var(--panel); }
.top .title { font-size: 16px; font-weight: 700; margin-bottom: 6px; overflow-wrap: anywhere; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { background: var(--chip); border-radius: 999px; padding: 2px 10px; font-size: 12px; color: var(--muted); }
.chip b { color: var(--text); font-weight: 600; }
.chip.run { color: var(--run); font-weight: 600; }
#feed { flex: 1; overflow-y: auto; padding: 16px 20px 40px; }
.empty { color: var(--muted); padding: 40px; text-align: center; }
.ev { margin: 8px 0; max-width: 980px; }
.who { font-size: 12px; color: var(--muted); margin-bottom: 3px; display: flex; gap: 8px; }
.bubble { border-radius: 10px; padding: 10px 14px; white-space: pre-wrap; overflow-wrap: anywhere; }
.manager .bubble { background: var(--claude-bg); border-left: 3px solid var(--claude); }
.manager .who b { color: var(--claude); }
.agent .bubble { background: var(--codex-bg); border-left: 3px solid var(--codex); }
.agent .who b { color: var(--codex); }
.agent.final .bubble { background: var(--final-bg); border-left-color: var(--final); }
.agent.final .who b { color: var(--final); }
.question .bubble { outline: 2px solid var(--claude); }
.row { display: flex; gap: 8px; align-items: baseline; font-size: 13px; color: var(--muted); padding: 2px 4px; }
.row .ic { width: 18px; text-align: center; flex: none; }
.row .body { min-width: 0; flex: 1; }
.row code { font-family: var(--mono); font-size: 12px; color: var(--text); overflow-wrap: anywhere; }
.row.fail code { color: var(--err); }
details summary { cursor: pointer; list-style: none; }
details summary::-webkit-details-marker { display: none; }
details pre { font-family: var(--mono); font-size: 12px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 420px; overflow: auto; margin: 6px 0 4px; color: var(--text); }
.divider { display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 12px; margin: 18px 0 10px; }
.divider::before, .divider::after { content: ""; flex: 1; border-top: 1px dashed var(--line); }
.error .bubble { background: var(--err-bg); border-left: 3px solid var(--err); color: var(--err); }
.thinking { font-size: 12px; color: var(--muted); padding: 4px; }
.live { display: flex; align-items: center; gap: 8px; color: var(--run); font-size: 13px; padding: 8px 4px; }
@media (max-width: 760px) {
  .app { grid-template-columns: 1fr; grid-template-rows: 38vh 1fr; }
  aside { border-right: 0; border-bottom: 1px solid var(--line); }
  main { height: auto; min-height: 0; }
  #feed { padding: 12px 16px 32px; }
}
</style>
</head>
<body>
<div class="app">
  <aside>
    <header>
      <h1>Codex 작업 보기</h1>
      <label class="follow"><input type="checkbox" id="follow" checked> 새 작업 자동으로 따라가기</label>
    </header>
    <div id="list"></div>
  </aside>
  <main>
    <div class="top" id="top"><div class="title">작업을 고르세요</div></div>
    <div id="feed"><div class="empty">Claude가 Codex에게 작업을 맡기면 여기에 실시간으로 나타납니다.</div></div>
  </main>
</div>
<script>
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const time = (ts) => ts ? new Date(ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
const ago = (ts) => {
  if (!ts) return '';
  const s = Math.round((Date.now() - new Date(ts)) / 1000);
  if (s < 60) return s + '초 전';
  if (s < 3600) return Math.round(s / 60) + '분 전';
  if (s < 86400) return Math.round(s / 3600) + '시간 전';
  return new Date(ts).toLocaleDateString('ko-KR');
};
const fmtN = (n) => n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n ?? 0);

let threads = [];
let current = null, since = 0, lastSummary = null;
let follow = true;
try { follow = localStorage.getItem('follow') !== '0'; } catch {}
$('#follow').checked = follow;
$('#follow').onchange = (e) => { follow = e.target.checked; try { localStorage.setItem('follow', follow ? '1' : '0'); } catch {} };

function renderList() {
  const byParent = {};
  for (const t of threads) if (t.parentId) (byParent[t.parentId] ??= []).push(t);
  const ids = new Set(threads.map((t) => t.id));
  const roots = threads.filter((t) => !t.parentId || !ids.has(t.parentId));
  const row = (t, child) => '<div class="thread' + (child ? ' child' : '') + (t.id === current ? ' active' : '') + '" data-id="' + t.id + '">' +
    '<div class="t">' + (t.nickname ? '↳ ' + esc(t.nickname) + ' · ' : '') + esc(t.title) + '</div>' +
    '<div class="s"><span class="dot' + (t.running ? ' run' : '') + '"></span>' + esc(t.model || '') + (t.effort ? ' · ' + esc(t.effort) : '') + ' · ' + ago(t.updatedAt) + '</div></div>';
  $('#list').innerHTML = roots.map((t) => row(t, false) + (byParent[t.id] || []).map((c) => row(c, true)).join('')).join('')
    || '<div class="empty">아직 맡긴 작업이 없습니다.</div>';
  for (const el of document.querySelectorAll('.thread')) el.onclick = () => { follow = false; $('#follow').checked = false; open(el.dataset.id); };
}

function renderTop(s) {
  const tk = s.tokens;
  const rl = s.rateLimit;
  const elapsed = s.startedAt ? Math.round((new Date(s.updatedAt) - new Date(s.startedAt)) / 1000) : 0;
  $('#top').innerHTML = '<div class="title">' + esc(s.title) + '</div><div class="chips">' +
    (s.running ? '<span class="chip run">● 작업 중</span>' : '<span class="chip">완료/대기</span>') +
    '<span class="chip">모델 <b>' + esc(s.model) + '</b></span>' +
    (s.effort ? '<span class="chip">추론 <b>' + esc(s.effort) + '</b></span>' : '') +
    (s.sandbox ? '<span class="chip">권한 <b>' + esc(s.sandbox) + '</b></span>' : '') +
    '<span class="chip">폴더 <b>' + esc(s.cwd) + '</b></span>' +
    (tk ? '<span class="chip">토큰 <b>' + fmtN(tk.total_tokens) + '</b> (출력 ' + fmtN(tk.output_tokens) + ')</span>' : '') +
    (rl ? '<span class="chip">주간 한도 <b>' + rl.used_percent + '%</b> 사용</span>' : '') +
    '<span class="chip">경과 <b>' + (elapsed >= 60 ? Math.floor(elapsed / 60) + '분 ' : '') + (elapsed % 60) + '초</b></span>' +
    '</div>';
}

const ICON = { command: '›_', files: '✎', tool: '⚙', search: '⌕', image: '▣' };
function evHtml(e) {
  const t = '<span>' + time(e.ts) + '</span>';
  switch (e.kind) {
    case 'manager':
      return '<div class="ev manager"><div class="who"><b>Claude → Codex</b>' + t + '</div><div class="bubble">' + esc(e.text) + '</div></div>';
    case 'agent': {
      const final = e.phase === 'final_answer';
      const q = /^\\s*QUESTION:/m.test(e.text);
      return '<div class="ev agent' + (final ? ' final' : '') + (q ? ' question' : '') + '"><div class="who"><b>' +
        (q ? 'Codex 질문' : final ? 'Codex 최종 보고' : 'Codex') + '</b>' + t + '</div><div class="bubble">' + esc(e.text) + '</div></div>';
    }
    case 'reasoning':
      return e.text ? '<div class="ev thinking">💭 ' + esc(e.text) + '</div>' : '';
    case 'turn_start':
      return '<div class="divider">차례 시작 · ' + time(e.ts) + '</div>';
    case 'turn_end':
      return '<div class="divider">' + (e.aborted ? '중단됨' : '차례 끝') + (e.durationMs ? ' · ' + Math.round(e.durationMs / 1000) + '초' : '') + ' · ' + time(e.ts) + '</div>';
    case 'error':
      return '<div class="ev error"><div class="who"><b>오류</b>' + t + '</div><div class="bubble">' + esc(e.text) + '</div></div>';
    case 'note':
      return '<div class="divider">' + esc(e.text) + '</div>';
    case 'files': {
      const title = e.files.map((f) => (f.type === 'add' ? '+ ' : f.type === 'delete' ? '− ' : '~ ') + f.path).join('\\n');
      return row(e, 'files', title);
    }
    default:
      return row(e, e.kind, e.title);
  }
}
function row(e, kind, title) {
  const fail = e.status === 'failed' || (e.exitCode != null && e.exitCode !== 0);
  const label = esc(title) + (e.exitCode != null && e.exitCode !== 0 ? ' (종료 코드 ' + e.exitCode + ')' : '') + (e.status === 'failed' ? ' (실패)' : '');
  const inner = '<span class="ic">' + (ICON[kind] || '•') + '</span><span class="body"><code>' + label + '</code>';
  if (e.detail) {
    return '<div class="ev row' + (fail ? ' fail' : '') + '"><span class="body" style="flex:1"><details><summary style="display:flex;gap:8px">' +
      inner + '</span></summary><pre>' + esc(e.detail) + '</pre></details></span></div>';
  }
  return '<div class="ev row' + (fail ? ' fail' : '') + '">' + inner + '</span></div>';
}

function atBottom() { const f = $('#feed'); return f.scrollHeight - f.scrollTop - f.clientHeight < 80; }

async function open(id) {
  current = id; since = 0; lastSummary = null;
  $('#feed').innerHTML = '';
  // 따라가기 중에는 주소를 비워 둬야 새로 고침해도 계속 따라간다
  history.replaceState(null, '', follow ? location.pathname : '#' + id);
  renderList();
  await poll();
  $('#feed').scrollTop = $('#feed').scrollHeight;
}

async function poll() {
  if (!current) return;
  const id = current;
  const r = await fetch('/api/thread/' + id + '?since=' + since).then((x) => x.ok ? x.json() : null).catch(() => null);
  if (!r || id !== current) return;
  const stick = atBottom();
  const feed = $('#feed');
  feed.querySelector('.live')?.remove();
  if (r.events.length) feed.insertAdjacentHTML('beforeend', r.events.map(evHtml).join(''));
  since = r.since + r.events.length;
  if (r.summary.running) feed.insertAdjacentHTML('beforeend', '<div class="live"><span class="dot run"></span>Codex가 작업 중… (마지막 기록 ' + ago(r.summary.updatedAt) + ')</div>');
  renderTop(r.summary);
  if (stick) feed.scrollTop = feed.scrollHeight;
}

async function refreshList() {
  const r = await fetch('/api/threads').then((x) => x.json()).catch(() => null);
  if (!r) return;
  threads = r.threads;
  const newest = threads.find((t) => !t.parentId) ?? threads[0];
  if (follow && newest && newest.id !== current) open(newest.id);
  else renderList();
}

(async () => {
  // 주소에 작업 ID(#...)가 있으면 그 작업을 고정해서 보여준다
  const hash = location.hash.slice(1);
  if (hash) { follow = false; $('#follow').checked = false; }
  await refreshList();
  if (hash) open(hash);
  setInterval(poll, 1500);
  setInterval(refreshList, 4000);
})();
</script>
</body>
</html>`;
