#!/usr/bin/env npx tsx

/**
 * OpenRouter cost tracking statusline for Claude Code
 *
 * Displays: Provider: model - $cost - cache discount: $saved
 *
 * Setup: Add to your ~/.claude/settings.json:
 * {
 *   "statusLine": {
 *     "type": "command",
 *     "command": "/path/to/statusline.sh"
 *   }
 * }
 *
 * Requires: ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY set to your OpenRouter API key
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { basename } from 'node:path';

interface StatuslineInput {
  session_id: string;
  transcript_path: string;
  cwd?: string;
  workspace?: {
    current_dir?: string;
    project_dir?: string;
  };
  model?: {
    id?: string;
    display_name?: string;
  };
  context_window?: {
    context_window_size: number;
    current_usage: {
      input_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
    };
  };
}

// ── 颜色常量（跟 ccr-append.js 对齐；只保留实际用到的键）
// reset            — 所有段尾复位
// dim              — L2/L3/L4 前缀 ├ / └ 的树形符
// green/yellow/red — L4 tokens 数字 + 进度条按 ≤60/≤80/>80 阈值染色；usage tracking 状态
// bright_blue      — L1 的 󰉋 workDir
// bright_green     — L1 的  branch
// bright_magenta   — L3 预算分母（limit，如 $500 / $0.50）
// bright_cyan      — L3 预算分子（usage，如 $416.61 / $0.33）
// bright_yellow    — L3 的  $cost 实际花费 / CCR 估算花费
// bright_red       — L2 的 󰚩 + provider: + model
const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  bright_blue: '\x1b[94m',
  bright_green: '\x1b[92m',
  bright_magenta: '\x1b[95m',
  bright_cyan: '\x1b[96m',
  bright_yellow: '\x1b[93m',
  bright_red: '\x1b[91m',
};

function gitBranch(cwd: string): string {
  try {
    if (!existsSync(cwd)) return '';
    const out = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
      timeout: 500,
    });
    return (out || '').trim();
  } catch {
    return '';
  }
}

interface GenerationData {
  total_cost: number;
  cache_discount: number | null;
  provider_name: string;
  model: string;
}

interface State {
  seen_ids: string[];
  total_cost: number;
  total_cache_discount: number;
  last_provider: string;
  last_model: string;
}

async function fetchGeneration(id: string, apiKey: string): Promise<GenerationData | null> {
  try {
    const res = await fetch(`https://openrouter.ai/api/v1/generation?id=${id}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (!res.ok) {
      return null;
    }

    const json = await res.json();
    const data = json?.data;

    if (!data || typeof data.total_cost !== 'number') {
      return null;
    }

    return data;
  } catch {
    return null;
  }
}

function extractGenerationIds(transcriptPath: string): string[] {
  try {
    const content = readFileSync(transcriptPath, 'utf-8');
    const ids: string[] = [];

    for (const line of content.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      try {
        const entry = JSON.parse(line);
        const messageId = entry?.message?.id;
        if (typeof messageId === 'string' && messageId.startsWith('gen-')) {
          ids.push(messageId);
        }
      } catch {
        // Skip malformed lines
      }
    }

    return [...new Set(ids)];
  } catch {
    return [];
  }
}

function loadState(statePath: string): State {
  const defaultState: State = {
    seen_ids: [],
    total_cost: 0,
    total_cache_discount: 0,
    last_provider: '',
    last_model: '',
  };

  if (!existsSync(statePath)) {
    return defaultState;
  }

  try {
    const content = readFileSync(statePath, 'utf-8');
    if (!content.trim()) {
      return defaultState;
    }

    const parsed = JSON.parse(content);

    // Validate state shape
    if (!Array.isArray(parsed.seen_ids)) {
      return defaultState;
    }

    return {
      seen_ids: parsed.seen_ids,
      total_cost: typeof parsed.total_cost === 'number' ? parsed.total_cost : 0,
      total_cache_discount:
        typeof parsed.total_cache_discount === 'number' ? parsed.total_cache_discount : 0,
      last_provider: typeof parsed.last_provider === 'string' ? parsed.last_provider : '',
      last_model: typeof parsed.last_model === 'string' ? parsed.last_model : '',
    };
  } catch {
    return defaultState;
  }
}

function saveState(statePath: string, state: State): void {
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function shortModelName(model: string): string {
  return model.replace(/^[^/]+\//, '').replace(/-\d{8}$/, '');
}

interface KeyInfo {
  usage: number;
  limit: number | null;
  limit_remaining: number | null;
}

async function fetchKeyInfo(apiKey: string): Promise<KeyInfo | null> {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/auth/key', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return null;
    const json = await res.json();
    const data = json?.data;
    if (!data || typeof data.usage !== 'number') return null;
    return {
      usage: data.usage,
      limit: typeof data.limit === 'number' ? data.limit : null,
      limit_remaining: typeof data.limit_remaining === 'number' ? data.limit_remaining : null,
    };
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY ?? '';

  if (!apiKey) {
    process.stdout.write(
      'Set ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY to use the OpenRouter statusline',
    );
    return;
  }

  let inputData = '';
  for await (const chunk of process.stdin) {
    inputData += chunk;
  }

  const input = JSON.parse(inputData);
  const session_id = input?.session_id;
  const transcript_path = input?.transcript_path;

  if (typeof session_id !== 'string' || typeof transcript_path !== 'string') {
    process.stdout.write('Invalid statusline input');
    return;
  }

  const statePath = `/tmp/claude-openrouter-cost-${session_id}.json`;
  const state = loadState(statePath);

  const allIds = extractGenerationIds(transcript_path);
  const seenSet = new Set(state.seen_ids);
  const newIds = allIds.filter((id) => !seenSet.has(id));

  let fetchSucceeded = 0;
  let fetchFailed = 0;

  for (const id of newIds) {
    const gen = await fetchGeneration(id, apiKey);

    if (!gen) {
      fetchFailed++;
      continue;
    }

    fetchSucceeded++;
    state.total_cost += gen.total_cost ?? 0;
    state.total_cache_discount += gen.cache_discount ?? 0;

    if (gen.provider_name) {
      state.last_provider = gen.provider_name;
    }
    if (gen.model) {
      state.last_model = gen.model;
    }

    state.seen_ids.push(id);
  }

  saveState(statePath, state);

  // 模型名优先用累计 state（真实 OpenRouter 返回的模型 ID），
  // 没有就退回到 CC 通过 stdin 传的 model.display_name / model.id，
  // 这样即使还没发过真实请求，L1 也能显示「󰚩 <模型名>」而不是孤零零一个图标。
  const stateModel = shortModelName(state.last_model);
  const ccModel = shortModelName(input?.model?.id ?? '');
  const shortModel = stateModel || ccModel || input?.model?.display_name || '';

  // usage tracking 状态指示
  let statusIndicator = '';
  if (newIds.length > 0) {
    if (fetchFailed === 0) {
      statusIndicator = `\nusage tracking: ${C.green}up-to-date${C.reset}`;
    } else {
      statusIndicator = `\nusage tracking: ${C.red}behind${C.reset}`;
    }
  }

  // cwd / git branch
  const cwd = input?.cwd ?? input?.workspace?.current_dir ?? process.cwd();
  const workDir = basename(cwd) || cwd;
  const branch = gitBranch(cwd);

  // OpenRouter key 预算（usage 染 bright_cyan；limit 染 bright_magenta；斜杠默认色）
  const keyInfo = await fetchKeyInfo(apiKey);
  const budgetStr = keyInfo
    ? `${C.bright_cyan}$${keyInfo.usage.toFixed(2)}${C.reset} / ${C.bright_magenta}${keyInfo.limit !== null ? `$${keyInfo.limit.toFixed(0)}` : '∞'}${C.reset}`
    : '';

  // tokens & 进度条（用量 + 10 格进度条，染色阈值跟 ccr-append.js 对齐）
  // stdin 没传 context_window 时退化成「0 / ? (0%) ░░░░░░░░░░」占位，保证 L4 永远可见。
  const fmtTok = (n: number) =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` :
    n >= 1_000     ? `${(n / 1_000).toFixed(1)}k` : `${n}`;
  const cw = input?.context_window;
  let used = 0, total = 0, pct = 0;
  if (cw?.current_usage && cw?.context_window_size) {
    used = cw.current_usage.input_tokens
      + cw.current_usage.cache_creation_input_tokens
      + cw.current_usage.cache_read_input_tokens;
    total = cw.context_window_size;
    pct = Math.round((used / total) * 100);
  }
  const usageColor = pct <= 60 ? C.green : pct <= 80 ? C.yellow : C.red;
  const filled = Math.max(0, Math.min(10, Math.floor(pct / 10)));
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
  const totalText = total > 0 ? fmtTok(total) : '?';
  const usageLine = `${usageColor}\u{F024D} ${fmtTok(used)} / ${totalText} (${pct}%)${C.reset}  ${usageColor}${bar}${C.reset}`;

  // L1：󰉋 workDir   main（workDir 亮蓝、branch 亮洋红）
  const line1Parts: string[] = [];
  if (workDir) line1Parts.push(`${C.bright_blue}\u{F024B} ${workDir}${C.reset}`);
  if (branch) line1Parts.push(`${C.bright_green}\u{E725} ${branch}${C.reset}`);
  const line1 = line1Parts.join('  ');

  // L2：├ 󰚩 provider: model（图标 + provider + model 都用 bright_cyan）
  const providerPart = state.last_provider ? `${C.bright_red}${state.last_provider}:${C.reset} ` : '';
  const modelPart = shortModel ? `${C.bright_red}${shortModel}${C.reset}` : '';
  const line2 = `${C.dim}├${C.reset}  ${C.bright_red}\u{F06A9}${C.reset} ${providerPart}${modelPart}`;

  // L3：├   $cost / $discount    $usage / $limit
  const costStr = `${C.bright_yellow} $${state.total_cost.toFixed(4)}${C.reset}` +
    ` \x1b[9m($${state.total_cache_discount.toFixed(2)})\x1b[29m`;
  const line3Parts: string[] = [`${C.dim}├${C.reset}`, costStr];
  if (budgetStr) line3Parts.push(budgetStr);
  const line3 = line3Parts.join('  ');

  // L4：└  󰉍 used / total (pct%) ██░░░░░░░░（永远显示，无 context_window 就占位 0 / ?）
  const line4 = `${C.dim}└${C.reset}  ${usageLine}`;

  const lines = [line1, line2, line3, line4].filter(Boolean);
  process.stdout.write(lines.join('\n') + statusIndicator);
}

main().catch((err) => {
  process.stdout.write(`error: ${err.message}`);
});
