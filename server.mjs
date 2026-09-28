#!/usr/bin/env node
// codex-bridge: Claude(총괄)가 ChatGPT OAuth로 로그인된 Codex 모델에게 일을 맡기는 MCP 서버.
// Claude 앱이 이 서버를 켜 두고, 첫 호출 때 `codex app-server`를 띄워 대기시킨다.
// 인증은 Codex가 관리하는 ChatGPT 로그인만 사용한다. API 키는 쓰지 않는다.

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import readline from 'node:readline';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const VERSION = '0.1.0';

// ---------------------------------------------------------------------------
// Codex 실행 파일 찾기
// ---------------------------------------------------------------------------
const IS_WIN = process.platform === 'win32';

function findCodex() {
  const candidates = [process.env.CODEX_BIN];
  if (!IS_WIN) {
    candidates.push(
      '/Applications/ChatGPT.app/Contents/Resources/codex',
      '/Applications/Codex.app/Contents/Resources/codex',
    );
  }
  try {
    // Windows의 `where`는 여러 줄을 돌려준다. 실행 파일(.exe)을 .cmd 래퍼보다 우선한다.
    const found = execFileSync(IS_WIN ? 'where' : '/usr/bin/which', ['codex'], { encoding: 'utf8' })
      .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (IS_WIN) found.sort((a, b) => Number(!/\.exe$/i.test(a)) - Number(!/\.exe$/i.test(b)));
    candidates.push(...found);
  } catch {}
  return candidates.find((p) => p && existsSync(p) && (!IS_WIN || /\.(exe|cmd|bat)$/i.test(p)));
}

// ---------------------------------------------------------------------------
// 작업 모델에게 항상 붙는 고정 규칙 (Claude가 쓴 프롬프트와 별개)
// ---------------------------------------------------------------------------
const WORKER_RULES = `You are a worker agent. Your manager is Claude, another AI that delegated this task on behalf of a human user. You cannot talk to the human directly; the manager relays everything.

Rules:
- Work autonomously. For minor choices, make a reasonable assumption and list it in your report.
- If you reach a decision that would significantly change the result and the task description does not settle it, STOP and ask the manager. End your message with a line that starts exactly with "QUESTION:" followed by the question, concrete options (A/B/...), and your recommendation. Do not continue the work in that turn; the manager's answer will arrive as the next message.
- When finished, give a final report: what you did, the result, absolute paths of files you created or changed, sources (URLs with access date) if you researched, and limitations. A final report must not contain a "QUESTION:" line.
- The given working directory is your main workspace. You may use any tool, plugin, network access and local file you have access to when it helps the task.
- Reply in the same language as the task prompt.`;

// 병렬 작업을 맡길 때만 추가되는 서브에이전트 지침
const SUBAGENT_RULES = `

Parallel work (sub-agents):
- This task benefits from parallelism. You are the lead of a small team: split the work into independent sub-tasks and run them concurrently with sub-agents (spawn_agent and the related agent tools) instead of doing everything sequentially yourself.
- Give each sub-agent a self-contained prompt: goal, scope, output format, and where to write files. Pick a model and reasoning effort that fit each sub-task (lighter models for simple collection, stronger ones for hard analysis).
- Sub-agents cannot reach the manager. Resolve their questions yourself; escalate to the manager with a "QUESTION:" line only when the decision is truly the user's.
- Wait for all sub-agents, then review, merge and verify their results yourself before the final report. In the report, list each sub-agent's role, model and outcome.`;

// 작업별 권한 수준. 모든 수준에서 네트워크 접속은 허용한다.
const ACCESS_LEVELS = {
  full: () => ({ sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } }),
  workspace: (cwd) => ({
    sandbox: 'workspace-write',
    sandboxPolicy: { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: true },
  }),
  'read-only': () => ({ sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: true } }),
};

// ---------------------------------------------------------------------------
// Codex App Server 클라이언트 (JSON-RPC over stdio)
// ---------------------------------------------------------------------------
class CodexAppServer {
  constructor(bin) {
    this.bin = bin;
    this.proc = null;
    this.ready = null;
    this.nextId = 0;
    this.pending = new Map();
    this.tasks = new Map(); // threadId -> task
    this.models = null;
    this.lastError = null;
  }

  ensure() {
    if (this.proc && this.proc.exitCode === null && this.ready) return this.ready;
    this.ready = this.#start();
    return this.ready;
  }

  async #start() {
    if (!this.bin) {
      throw new Error('Codex 실행 파일을 찾지 못했습니다. ChatGPT 앱 또는 `npm i -g @openai/codex`로 Codex를 설치하거나, CODEX_BIN 환경 변수에 경로를 지정하세요.');
    }
    const env = { ...process.env };
    // API 키 경로 차단: OAuth(ChatGPT 로그인)만 쓰도록 알려진 키 변수를 제거한다.
    for (const k of Object.keys(env)) if (/^(OPENAI|CODEX)_API_KEY$|^AZURE_OPENAI/.test(k)) delete env[k];

    // 평소 Codex 설정(플러그인, 메모리, 앱 연동)을 그대로 쓰고, 서브에이전트 기능만 확실히 켠다.
    // npm으로 설치한 Windows codex는 codex.cmd 래퍼라서 셸을 거쳐야 실행된다. (인자는 고정값)
    const viaShell = IS_WIN && /\.(cmd|bat)$/i.test(this.bin);
    const proc = spawn(viaShell ? `"${this.bin}"` : this.bin, ['app-server', '--enable', 'multi_agent'],
      { stdio: ['pipe', 'pipe', 'pipe'], env, shell: viaShell, windowsHide: true });
    this.proc = proc;
    readline.createInterface({ input: proc.stdout }).on('line', (line) => this.#onLine(line));
    proc.stderr.on('data', (d) => { this.lastError = d.toString().slice(-2000); });
    proc.on('exit', (code) => {
      for (const { reject } of this.pending.values()) reject(new Error(`Codex 서버가 종료되었습니다 (code ${code})`));
      this.pending.clear();
      for (const t of this.tasks.values()) {
        if (t.status === 'running') { t.status = 'failed'; t.error = 'Codex 서버가 작업 도중 종료되었습니다.'; this.#wake(t); }
        t.loaded = false;
      }
      this.proc = null;
      this.ready = null;
    });

    await this.request('initialize', { clientInfo: { name: 'codex-bridge', title: 'Claude Codex Bridge', version: VERSION } });
    this.#send({ jsonrpc: '2.0', method: 'initialized' });

    const acc = await this.request('account/read', {});
    if (acc?.account?.type !== 'chatgpt') {
      proc.kill();
      throw new Error(
        `Codex가 ChatGPT OAuth 로그인 상태가 아닙니다 (현재: ${acc?.account?.type ?? '로그인 안 됨'}). ` +
        'API 키로 우회하지 않습니다. 터미널에서 `codex login`으로 ChatGPT 계정 로그인을 해 주세요.',
      );
    }
    this.account = acc.account;
  }

  #send(msg) { this.proc.stdin.write(JSON.stringify(msg) + '\n'); }

  request(method, params, timeoutMs = 60_000) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} 응답 시간 초과`)); }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.#send({ jsonrpc: '2.0', id, method, params });
    });
  }

  #onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    if (msg.id !== undefined && msg.method) return this.#onServerRequest(msg);
    if (msg.method) this.#onNotification(msg.method, msg.params || {});
  }

  // Codex가 사람의 승인을 요청하는 경우: full 권한 작업이면 명령·파일 변경을 허용하고,
  // 그 외에는 거절한다. 플러그인의 사용자 확인 요청(elicitation)은 사람이 없으므로 항상 거절한다.
  #onServerRequest({ id, method, params }) {
    const reply = (result) => this.#send({ jsonrpc: '2.0', id, result });
    const task = params?.threadId ? this.tasks.get(params.threadId) : null;
    const full = task?.access === 'full';
    const isExecApproval = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
      'applyPatchApproval', 'execCommandApproval'].includes(method);
    if (task && !(full && isExecApproval)) task.activity.declined.push(method);
    switch (method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        return reply({ decision: full ? 'accept' : 'decline' });
      case 'applyPatchApproval':
      case 'execCommandApproval':
        return reply({ decision: full ? 'approved' : 'denied' });
      case 'mcpServer/elicitation/request':
        return reply({ action: 'decline', content: null });
      case 'item/tool/requestUserInput': {
        const answers = {};
        for (const q of params?.questions ?? []) {
          answers[q.id] = { answers: ['The manager cannot answer mid-turn. End your turn with a "QUESTION:" line instead.'] };
        }
        return reply({ answers });
      }
      default:
        return this.#send({ jsonrpc: '2.0', id, error: { code: -32601, message: `codex-bridge does not support ${method}` } });
    }
  }

  #onNotification(method, params) {
    const task = params.threadId ? this.tasks.get(params.threadId) : null;
    if (method === 'account/rateLimits/updated') { this.rateLimits = params.rateLimits; return; }
    if (!task) return;

    if (method === 'item/completed') {
      const item = params.item || {};
      if (item.type === 'agentMessage') task.turnMessages.push({ text: item.text ?? '', phase: item.phase });
      else if (item.type === 'commandExecution') task.activity.commands.push(String(item.command ?? '').slice(0, 200));
      else if (item.type === 'fileChange') for (const c of item.changes ?? []) task.activity.files.add(c.path);
      else if (item.type === 'webSearch') task.activity.searches.push(item.query ?? '');
      else if (item.type === 'mcpToolCall') task.activity.tools.push(`${item.server}.${item.tool}`);
      else if (item.type === 'subAgentActivity' && item.kind === 'started') {
        task.activity.subagents.push(String(item.agentPath ?? item.agentThreadId).split('/').pop());
      } else if (item.type === 'collabAgentToolCall' && item.tool === 'spawnAgent') {
        task.activity.subagents.push(`${item.model ?? '기본 모델'}${item.reasoningEffort ? `/${item.reasoningEffort}` : ''}`);
      }
    } else if (method === 'item/autoApprovalReview/completed') {
      const status = params.review?.status ?? 'unknown';
      task.activity.reviews[status] = (task.activity.reviews[status] ?? 0) + 1;
    } else if (method === 'model/rerouted') {
      task.rerouted = params;
    } else if (method === 'turn/completed') {
      const turn = params.turn || {};
      const msgs = task.turnMessages;
      const final = msgs.filter((m) => m.phase === 'final_answer').pop() ?? msgs[msgs.length - 1];
      task.lastMessage = final?.text ?? '';
      task.turnId = null;
      if (turn.status === 'completed') {
        task.status = /^\s*QUESTION:/m.test(task.lastMessage) ? 'question' : 'done';
      } else if (turn.status === 'interrupted') {
        task.status = 'cancelled';
      } else {
        task.status = 'failed';
        task.error = turn.error?.message ?? JSON.stringify(turn.error ?? turn.status);
      }
      this.#wake(task);
    } else if (method === 'error') {
      task.error = params.error?.message ?? JSON.stringify(params);
    }
  }

  #wake(task) { for (const w of task.waiters.splice(0)) w(); }

  waitForTurn(task, seconds, onTick) {
    if (task.status !== 'running') return Promise.resolve();
    return new Promise((resolve) => {
      const tick = onTick ? setInterval(onTick, 15_000) : null;
      const done = () => { clearTimeout(timer); if (tick) clearInterval(tick); resolve(); };
      const timer = setTimeout(() => { task.waiters = task.waiters.filter((w) => w !== done); done(); }, seconds * 1000);
      task.waiters.push(done);
    });
  }

  async listModels() {
    await this.ensure();
    const res = await this.request('model/list', {});
    this.models = res.data.filter((m) => !m.hidden);
    return this.models;
  }

  async resolveModel(name) {
    const models = this.models ?? (await this.listModels());
    const n = name.trim().toLowerCase();
    const exact = models.find((m) => m.id.toLowerCase() === n || m.displayName?.toLowerCase() === n);
    if (exact) return exact;
    const hits = models.filter((m) => m.id.toLowerCase().includes(n) || m.displayName?.toLowerCase().includes(n));
    if (hits.length === 1) return hits[0];
    const list = models.map((m) => m.id).join(', ');
    if (hits.length === 0) throw new Error(`'${name}' 모델을 찾을 수 없습니다. 사용 가능: ${list}. 다른 모델로 임의 대체하지 않습니다.`);
    throw new Error(`'${name}'에 해당하는 모델이 여러 개입니다: ${hits.map((m) => m.id).join(', ')}. 정확한 ID를 지정하세요.`);
  }

  async startTask({ model, effort, prompt, cwd, access, subagents }) {
    await this.ensure();
    const m = await this.resolveModel(model);
    const efforts = (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort ?? e);
    const eff = effort ?? m.defaultReasoningEffort;
    if (effort && !efforts.includes(effort)) {
      throw new Error(`${m.id}은(는) 추론 수준 '${effort}'을(를) 지원하지 않습니다. 지원: ${efforts.join(', ')}`);
    }
    const { sandbox, sandboxPolicy } = ACCESS_LEVELS[access](cwd);
    const instructions = WORKER_RULES + (subagents ? SUBAGENT_RULES : '');
    const res = await this.request('thread/start', {
      // 샌드박스 밖 동작·네트워크 차단·플러그인 확인은 사용자 대신 Codex 자동 검토(auto_review)가 판단한다.
      cwd, model: m.id, sandbox, approvalPolicy: 'on-request', approvalsReviewer: 'auto_review',
      developerInstructions: instructions,
      serviceName: 'codex-bridge',
    });
    const threadId = res.thread.id;
    const task = {
      threadId, model: m.id, modelName: m.displayName, effort: eff, cwd, access, sandboxPolicy, subagents, instructions,
      status: 'idle', turnId: null, turnMessages: [], lastMessage: '', error: null, rerouted: null,
      activity: { commands: [], files: new Set(), searches: [], tools: [], subagents: [], declined: [], reviews: {} },
      waiters: [], loaded: true, turns: 0, startedAt: Date.now(),
    };
    this.tasks.set(threadId, task);
    await this.#runTurn(task, prompt, eff);
    return task;
  }

  async reply(threadId, message, effort) {
    await this.ensure();
    let task = this.tasks.get(threadId);
    if (!task) throw new Error(`작업 ${threadId}을(를) 찾을 수 없습니다. (이 Claude 세션에서 시작한 작업만 이어갈 수 있습니다)`);
    if (task.status === 'running') throw new Error('작업 모델이 아직 작업 중입니다. codex_wait로 결과를 먼저 받으세요.');
    if (!task.loaded) {
      await this.request('thread/resume', { threadId, developerInstructions: task.instructions });
      task.loaded = true;
    }
    if (effort) {
      const m = await this.resolveModel(task.model);
      const efforts = (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort ?? e);
      if (!efforts.includes(effort)) throw new Error(`${m.id}은(는) 추론 수준 '${effort}'을(를) 지원하지 않습니다. 지원: ${efforts.join(', ')}`);
      task.effort = effort;
    }
    await this.#runTurn(task, message, task.effort);
    return task;
  }

  async #runTurn(task, text, effort) {
    task.status = 'running';
    task.error = null;
    task.turnMessages = [];
    task.turns += 1;
    const res = await this.request('turn/start', {
      threadId: task.threadId, model: task.model, effort, sandboxPolicy: task.sandboxPolicy,
      input: [{ type: 'text', text, text_elements: [] }],
    });
    task.turnId = res.turn.id;
  }

  async cancel(threadId) {
    const task = this.tasks.get(threadId);
    if (!task) throw new Error(`작업 ${threadId}을(를) 찾을 수 없습니다.`);
    if (task.status !== 'running' || !task.turnId) return task;
    await this.request('turn/interrupt', { threadId, turnId: task.turnId });
    await this.waitForTurn(task, 20);
    return task;
  }

  shutdown() {
    const proc = this.proc;
    if (!proc) return;
    try {
      // Windows에서는 cmd.exe 아래의 codex까지 프로세스 트리째 종료한다.
      if (IS_WIN) execFileSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
      else proc.kill();
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// 결과를 Claude가 읽기 좋은 텍스트로
// ---------------------------------------------------------------------------
function formatTask(task) {
  const a = task.activity;
  const secs = Math.round((Date.now() - task.startedAt) / 1000);
  const statusText = {
    running: 'running (아직 작업 중 → codex_wait로 계속 기다리세요)',
    question: 'question (작업 모델이 질문했습니다 → 판단해서 codex_reply로 답하세요)',
    done: 'done (완료 보고가 도착했습니다 → 검토 후 필요하면 codex_reply로 보완 요청)',
    failed: 'failed',
    cancelled: 'cancelled',
  }[task.status] ?? task.status;
  const lines = [
    `작업 ID: ${task.threadId}`,
    `모델: ${task.modelName ?? task.model} (${task.model}) · 추론 수준: ${task.effort}`,
    `권한: ${task.access}${task.subagents ? ' · 서브에이전트 사용' : ''}`,
    `상태: ${statusText}`,
    `경과: ${secs}초 · 주고받은 차례: ${task.turns}`,
  ];
  const act = [];
  if (a.searches.length) act.push(`웹 검색 ${a.searches.length}회`);
  if (a.commands.length) act.push(`명령 실행 ${a.commands.length}회`);
  if (a.files.size) act.push(`변경 파일: ${[...a.files].join(', ')}`);
  if (a.subagents.length) act.push(`서브에이전트 ${a.subagents.length}개 (${a.subagents.join(', ')})`);
  if (a.tools.length) act.push(`플러그인·도구 호출 ${a.tools.length}회 (${[...new Set(a.tools)].join(', ')})`);
  const reviewNames = { approved: '허용', denied: '거절', timedOut: '시간 초과', aborted: '중단' };
  const reviews = Object.entries(a.reviews).map(([s, n]) => `${reviewNames[s] ?? s} ${n}`);
  if (reviews.length) act.push(`자동 승인 검토: ${reviews.join(', ')}`);
  if (a.declined.length) act.push(`거절된 확인 요청 ${a.declined.length}건 (${[...new Set(a.declined)].join(', ')})`);
  if (act.length) lines.push(`활동: ${act.join(' · ')}`);
  if (task.rerouted) lines.push(`⚠ 서버가 모델을 변경했습니다: ${JSON.stringify(task.rerouted)}`);
  if (task.error) lines.push(`오류: ${task.error}`);
  if (task.status !== 'running') {
    lines.push('', '----- 작업 모델의 메시지 -----', task.lastMessage || '(메시지 없음)');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// MCP 서버 (Claude 앱에 보이는 도구)
// ---------------------------------------------------------------------------
const codex = new CodexAppServer(findCodex());

const INSTRUCTIONS = `codex 서버는 사용자의 ChatGPT(Codex) OAuth 로그인으로 OpenAI 모델(예: Luna=gpt-5.6-luna, Sol=gpt-5.6-sol, Terra, Astra)에게 일을 맡기는 도구다.
사용 시점: 사용자가 "루나/솔 등에게 맡겨"처럼 위임을 직접 지시했을 때. 사용자가 시키지 않았는데 먼저 위임하려면 먼저 사용자에게 제안하고 허락을 받는다.
진행 방법:
1. 필요하면 codex_models로 실제 모델 ID와 지원 추론 수준을 확인한다.
2. codex_start로 맡긴다. prompt는 작업 모델이 그것만 읽고 이해할 수 있게 목표, 필요한 배경, 범위, 결과 형식, 완료 기준을 담아 새로 쓴다. 사용자와의 대화 전체나 관계없는 개인 정보는 붙이지 않는다. cwd는 작업할 폴더(현재 프로젝트 등)를 절대 경로로 준다.
3. 추론 수준을 사용자가 맡기면 직접 고른다: 단순 조회·요약 low, 일반 작업 medium, 복잡한 분석·코딩 high, 매우 어려운 문제 xhigh 이상. 고른 이유를 사용자에게 한 줄로 알린다.
4. 결과 상태가 question이면 원래 사용자 요청을 근거로 직접 결정해 codex_reply로 답한다. 사용자의 취향, 비용, 작업 범위 확대처럼 사용자만 정할 수 있는 것만 사용자에게 묻는다.
5. running이면 codex_wait로 계속 기다린다. done이면 결과를 검토하고, 부족하면 codex_reply로 보완을 요청한다.
6. 끝나면 사용자에게 보고한다: 맡긴 모델과 추론 수준, 보낸 프롬프트 요지, 오간 질문과 답, 최종 결과, 생성된 파일, 서브에이전트를 썼다면 그 구성.
권한(access): 기본은 workspace(cwd 안에서만 수정, 네트워크·플러그인 사용 가능). 작업 폴더 밖 접근 등은 Codex의 자동 검토(auto_review)가 사용자 대신 승인하거나 거절한다. 조사·검토만 필요하면 read-only. full(컴퓨터 전체)은 사용자가 명시적으로 요청할 때만 쓴다.
병렬 작업(subagents): 작업을 독립적인 여러 갈래로 나눌 수 있어 동시에 처리하면 빨라지거나, 사용자가 병렬/서브에이전트를 요청하면 subagents=true로 맡긴다. 이때는 상위 모델(Astra 또는 Sol)과 high 이상의 추론 수준을 쓰는 것을 기본으로 한다(ultra는 모델이 스스로 적극적으로 서브에이전트를 쓴다). 구조는 사용자 → Claude(총괄) → 상위 모델(팀장) → 서브에이전트들이다. 서브에이전트는 Claude와 직접 대화하지 않고, 팀장 모델이 결과를 모아 보고한다.
지킬 것: 사용자가 지정한 모델을 다른 모델로 바꾸지 않는다. 로그인 오류나 한도 소진이 생기면 API 키 등 다른 경로로 우회하지 말고 사용자에게 알린다.`;

const server = new McpServer({ name: 'codex', version: VERSION }, { instructions: INSTRUCTIONS });

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const fail = (e) => ({ content: [{ type: 'text', text: `오류: ${e.message}` }], isError: true });

function progressTicker(extra, task) {
  const token = extra?._meta?.progressToken;
  if (token === undefined) return undefined;
  let n = 0;
  return () => {
    n += 1;
    extra.sendNotification({
      method: 'notifications/progress',
      params: { progressToken: token, progress: n, message: `${task.modelName ?? task.model} 작업 중… (${n * 15}초)` },
    }).catch(() => {});
  };
}

const waitField = z.number().int().min(5).max(1500).optional()
  .describe('결과를 기다릴 최대 초 (기본 240). 시간이 지나도 작업은 계속되며 codex_wait로 이어서 기다린다.');

server.registerTool('codex_models', {
  title: 'Codex 모델 목록',
  description: 'ChatGPT OAuth로 로그인된 Codex 계정에서 쓸 수 있는 모델과 지원 추론 수준, 로그인 상태, 사용량 한도를 보여준다.',
  inputSchema: {},
}, async () => {
  try {
    const models = await codex.listModels();
    const lines = models.map((m) => {
      const eff = (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort ?? e).join('/');
      return `- ${m.displayName} → id: ${m.id} · 추론: ${eff} · 기본: ${m.defaultReasoningEffort}${m.isDefault ? ' · (계정 기본 모델)' : ''}`;
    });
    const rl = codex.rateLimits?.primary;
    return text([
      `로그인: ChatGPT OAuth (${codex.account?.planType ?? '?'} 플랜)`,
      rl ? `사용량: ${rl.usedPercent}% 사용 (리셋: ${new Date(rl.resetsAt * 1000).toLocaleString('ko-KR')})` : null,
      '', ...lines,
    ].filter((x) => x !== null).join('\n'));
  } catch (e) { return fail(e); }
});

server.registerTool('codex_start', {
  title: 'Codex 모델에게 작업 맡기기',
  description: '새 Codex 작업을 시작한다. 작업 모델이 끝내거나 질문하면 결과를 돌려준다. 상태가 question이면 codex_reply로 답하고, running이면 codex_wait로 기다린다.',
  inputSchema: {
    model: z.string().describe('모델 ID 또는 별칭. 예: "luna", "sol", "gpt-5.6-luna"'),
    effort: z.string().optional().describe('추론 수준. 예: low, medium, high, xhigh, max. 생략하면 모델 기본값'),
    prompt: z.string().min(1).describe('작업 모델에게 보낼 독립적인 작업 지시문'),
    cwd: z.string().describe('작업 폴더 절대 경로 (작업 모델의 기본 작업 위치)'),
    access: z.enum(['workspace', 'read-only', 'full']).optional()
      .describe('workspace(기본): cwd 안에서만 수정, 네트워크 허용, 그 밖의 동작은 자동 검토 후 승인/거절. read-only: 수정 불가. full: 컴퓨터 전체 접근(사용자가 명시적으로 요청할 때만)'),
    subagents: z.boolean().optional()
      .describe('true면 작업 모델에게 서브에이전트로 일을 나눠 병렬 처리하라는 지침을 준다. 상위 모델(astra, sol)과 함께 쓰는 것을 권장'),
    waitSeconds: waitField,
  },
}, async ({ model, effort, prompt, cwd, access = 'workspace', subagents = false, waitSeconds = 240 }, extra) => {
  try {
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`작업 폴더가 없습니다: ${cwd}`);
    const task = await codex.startTask({ model, effort, prompt, cwd, access, subagents });
    await codex.waitForTurn(task, waitSeconds, progressTicker(extra, task));
    return text(formatTask(task));
  } catch (e) { return fail(e); }
});

server.registerTool('codex_reply', {
  title: 'Codex 작업 모델에게 답하기',
  description: '진행 중인 Codex 작업에 답변이나 추가 지시를 보낸다(같은 대화를 이어감). 작업 모델의 질문에 답하거나 보완을 요청할 때 쓴다.',
  inputSchema: {
    taskId: z.string().describe('codex_start가 돌려준 작업 ID'),
    message: z.string().min(1).describe('작업 모델에게 보낼 답변 또는 추가 지시'),
    effort: z.string().optional().describe('이번 차례부터 바꿀 추론 수준 (생략하면 유지)'),
    waitSeconds: waitField,
  },
}, async ({ taskId, message, effort, waitSeconds = 240 }, extra) => {
  try {
    const task = await codex.reply(taskId, message, effort);
    await codex.waitForTurn(task, waitSeconds, progressTicker(extra, task));
    return text(formatTask(task));
  } catch (e) { return fail(e); }
});

server.registerTool('codex_wait', {
  title: 'Codex 작업 결과 기다리기',
  description: '아직 작업 중(running)인 Codex 작업의 결과를 더 기다린다. 이미 끝났으면 바로 현재 상태를 돌려준다.',
  inputSchema: { taskId: z.string(), waitSeconds: waitField },
}, async ({ taskId, waitSeconds = 240 }, extra) => {
  try {
    const task = codex.tasks.get(taskId);
    if (!task) throw new Error(`작업 ${taskId}을(를) 찾을 수 없습니다.`);
    await codex.waitForTurn(task, waitSeconds, progressTicker(extra, task));
    return text(formatTask(task));
  } catch (e) { return fail(e); }
});

server.registerTool('codex_cancel', {
  title: 'Codex 작업 중단',
  description: '진행 중인 Codex 작업을 중단한다. 이미 만들어진 파일 변경은 되돌리지 않는다.',
  inputSchema: { taskId: z.string() },
}, async ({ taskId }) => {
  try { return text(formatTask(await codex.cancel(taskId))); } catch (e) { return fail(e); }
});

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { codex.shutdown(); process.exit(0); });
process.stdin.on('close', () => { codex.shutdown(); process.exit(0); });
process.on('exit', () => codex.shutdown());

await server.connect(new StdioServerTransport());
