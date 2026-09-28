#!/usr/bin/env node
// codex-bridge를 Claude(Claude Code / Claude 앱 Code 탭)에 user 범위 MCP 서버 "codex"로 등록한다.
// macOS와 Windows 공통. 사용법: node register.mjs

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const IS_WIN = process.platform === 'win32';
const serverPath = join(dirname(fileURLToPath(import.meta.url)), 'server.mjs');

function which(name) {
  try {
    return execFileSync(IS_WIN ? 'where' : '/usr/bin/which', [name], { encoding: 'utf8' })
      .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
}

// Claude 앱은 터미널 PATH를 모를 수 있으므로 node와 server.mjs 모두 절대 경로로 등록한다.
// PATH의 node를 우선한다. (process.execPath는 Homebrew에서 버전이 박힌 Cellar 경로라 업그레이드 시 깨짐)
const node = which('node').find((p) => !IS_WIN || /\.exe$/i.test(p)) ?? process.execPath;
const config = { type: 'stdio', command: node, args: [serverPath], timeout: 1_800_000 };

// Windows의 .cmd 래퍼는 JSON 인자 따옴표가 깨지므로 .exe만 쓴다.
const claude = which('claude').find((p) => !IS_WIN || /\.exe$/i.test(p));
if (claude) {
  try { execFileSync(claude, ['mcp', 'remove', 'codex', '-s', 'user'], { stdio: 'ignore' }); } catch {}
  execFileSync(claude, ['mcp', 'add-json', 'codex', JSON.stringify(config), '-s', 'user'], { stdio: 'inherit' });
} else {
  // claude CLI가 없으면 ~/.claude.json에 직접 쓴다. (Claude 앱을 완전히 종료한 상태에서 실행할 것)
  const file = join(homedir(), '.claude.json');
  const data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  if (existsSync(file)) copyFileSync(file, `${file}.bak-codex-bridge`);
  data.mcpServers = { ...(data.mcpServers ?? {}), codex: config };
  writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(`claude CLI를 찾지 못해 ${file}에 직접 등록했습니다. (백업: .claude.json.bak-codex-bridge)`);
}

console.log('\n등록 완료:', JSON.stringify(config, null, 2));
console.log('Claude 앱을 다시 시작하면 codex 도구가 보입니다.');
