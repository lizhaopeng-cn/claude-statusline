/**
 * CCR StatusLine script：输出三行
 *
 *   第 1 行（身份）： model  workDir  git
 *   第 2 行（用量）： ├ ↑in  ↓out  tokens: used / total (pct%)  ██░░░░░░░░
 *   第 3 行（花费）： └ 💰cost  or: … / …  or1: … / …
 *
 * 已知限制：Claude Code 2.1.119 的 statusLine 渲染外层是 <Text wrap="truncate">，
 * Ink 5 的 truncate 模式遇到 '\n' 会把后续行整段丢掉，只渲染第 1 行。所以窄窗口下
 * 只看得到第 1 行，宽窗口下三行都能看到。每行独立按终端宽度 `…` 截断。
 *
 * 用法：CCR 的 StatusLine.default.modules 里只留一个 { type:"script", scriptPath } 模块指向本文件。
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const CCR_CONFIG = path.join(os.homedir(), ".claude-code-router", "config.json");
const CACHE_FILE = "/tmp/ccr-budget-cache.json";
const CACHE_TTL_MS = 20_000;

// 想看 CCR 实际传进来的 variables 是什么样，打开这个开关
// 每次状态栏刷新都会追加一条到 /tmp/ccr-append-debug.log
const DEBUG_DUMP = false;

// ── ANSI 颜色（bright_* 用 9x 序列，对应 CCR modules 的 bright_blue / bright_magenta / ...）
const C = {
  reset:           "\x1b[0m",
  dim:             "\x1b[2m",
  green:           "\x1b[32m",
  yellow:          "\x1b[33m",
  red:             "\x1b[31m",
  cyan:            "\x1b[36m",
  magenta:         "\x1b[35m",
  white:           "\x1b[37m",
  bright_blue:     "\x1b[94m",
  bright_magenta:  "\x1b[95m",
  bright_cyan:     "\x1b[96m",
  bright_yellow:   "\x1b[93m",
  bright_green:    "\x1b[92m",
  bright_red:      "\x1b[91m",
  bright_white:    "\x1b[97m",
  orange:          "\x1b[38;5;208m",
};

// ── ANSI-aware 单行截断（和 statusline.ts 里的保持一致）
function visibleLen(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function truncateLine(s, max) {
  if (max <= 0 || visibleLen(s) <= max) return s;
  let out = "";
  let visible = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\x1b" && s[i + 1] === "[") {
      const end = s.indexOf("m", i);
      if (end > 0) {
        out += s.slice(i, end + 1);
        i = end;
        continue;
      }
    }
    if (visible >= max - 1) {
      out += "…";
      break;
    }
    out += s[i];
    visible++;
  }
  return out + "\x1b[0m";
}

function getTermCols() {
  const envCols = Number(process.env.COLUMNS);
  if (Number.isFinite(envCols) && envCols > 0) return envCols;
  if (process.stdout && process.stdout.columns) return process.stdout.columns;
  return 120;
}

// ── 工具函数
function fmtNum(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

/**
 * 宽容地把 CCR 传进来的值解析成数字。
 * 支持：number、"6.3k"、"1.2M"、"20594"、"10%"、"1,234"、带前后空白等
 */
function parseNum(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v !== "string") return 0;
  const s = v.trim().replace(/[,\s%]/g, "").toLowerCase();
  if (!s) return 0;
  const m = s.match(/^([+-]?\d*\.?\d+)\s*([kmb]?)$/);
  if (!m) {
    const raw = Number(s);
    return Number.isFinite(raw) ? raw : 0;
  }
  const base = parseFloat(m[1]);
  if (!Number.isFinite(base)) return 0;
  const unit = m[2];
  if (unit === "k") return base * 1_000;
  if (unit === "m") return base * 1_000_000;
  if (unit === "b") return base * 1_000_000_000;
  return base;
}

function fmtMoney(n) {
  return `$${Number(n).toFixed(2)}`;
}

function fmtLimit(n) {
  if (n === null || n === undefined) return "∞";
  // 整数限额就不带小数点
  return Number.isInteger(n) ? `$${n}` : `$${Number(n).toFixed(2)}`;
}

// ── 从 CCR config 读 providers（name + api_key）
function readCcrProviders() {
  try {
    const j = JSON.parse(fs.readFileSync(CCR_CONFIG, "utf-8"));
    const providers = Array.isArray(j.Providers) ? j.Providers : [];
    return providers
      .filter((p) => p && p.name && p.api_key)
      .map((p) => ({ name: p.name, api_key: p.api_key }));
  } catch {
    return [];
  }
}

// ── 文件缓存（避免每秒都打 OpenRouter）
function loadCache() {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
    if (c && typeof c.ts === "number" && Date.now() - c.ts < CACHE_TTL_MS) {
      return c.data;
    }
  } catch {}
  return null;
}

function saveCache(data) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ ts: Date.now(), data }));
  } catch {}
}

// ── 查 OpenRouter key 使用情况
async function fetchKeyInfo(apiKey) {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/auth/key", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return null;
    const j = await res.json();
    const d = j?.data;
    if (!d || typeof d.usage !== "number") return null;
    return {
      usage: d.usage,
      limit: typeof d.limit === "number" ? d.limit : null,
    };
  } catch {
    return null;
  }
}

async function getAllBudgets() {
  const cached = loadCache();
  if (cached) return cached;

  const providers = readCcrProviders();
  const results = await Promise.all(
    providers.map(async (p) => ({
      name: p.name,
      info: await fetchKeyInfo(p.api_key),
    })),
  );
  saveCache(results);
  return results;
}

// ── 把 CCR 模型 ID 缩短一点：anthropic/claude-4.7-opus-20260416 → claude-4.7-opus
function shortenModel(m) {
  if (!m) return "";
  return String(m).replace(/^[^/]+\//, "").replace(/-\d{8}$/, "");
}

// 把单个模块渲染成带色彩的 "icon text"；text 为空则返回空串
function mod(icon, text, color) {
  const t = text == null ? "" : String(text).trim();
  if (!t) return "";
  const c = C[color] || "";
  const prefix = icon ? `${icon} ` : "";
  return `${c}${prefix}${t}${C.reset}`;
}

// 第 1 行（身份）：model  workDir  git
// 每个栏目内部：图标 + " " + 文字（1 格）；栏目之间：2 格。
function formatIdentityLine(v) {
  const parts = [];
  parts.push(mod("\u{F06A9}", shortenModel(v.model), "bright_cyan"));
  parts.push(mod("\u{F024B}", v.workDirName, "bright_blue"));
  parts.push(mod("\u{E725}",  v.gitBranch,   "bright_magenta"));
  return parts.filter(Boolean).join("  ");
}

// 第 2 行（用量）：├ ↑in  ↓out  󰉍 used / total (pct%)  ██░░░░░░░░
// used 按 contextPercent × total 反推，跟 /context 面板对齐。
// 染色阈值：≤60 绿 / ≤80 黄 / >80 红（tokens 数字和进度条同色）。
function formatUsageLine(v) {
  const parts = [];
  parts.push(`${C.dim}├${C.reset}`);

  parts.push(mod("↑", v.inputTokens,  "bright_green"));
  parts.push(mod("↓", v.outputTokens, "orange"));

  const totalRaw = parseNum(v.contextWindowSize);
  const total = totalRaw > 0 ? totalRaw : 200_000;
  const pct = Math.round(parseNum(v.contextPercent));
  const used = Math.round((pct / 100) * total);
  const color = pct <= 60 ? C.green : pct <= 80 ? C.yellow : C.red;
  parts.push(`${color}\u{F024D} ${fmtNum(used)} / ${fmtNum(total)} (${pct}%)${C.reset}`);

  // 10 格进度条：前 filled 格用 █、剩余用 ░，整体同色。每 10% 算满一格（向下取整）。
  const filled = Math.max(0, Math.min(10, Math.floor(pct / 10)));
  const bar = "█".repeat(filled) + "░".repeat(10 - filled);
  parts.push(`${color}${bar}${C.reset}`);

  return parts.filter(Boolean).join("  ");
}

// 第 3 行（花费）：└ 💰 cost  or: $x / $y  or1: $x / $y
function formatCostLine(v, results) {
  const parts = [];
  parts.push(`${C.dim}└${C.reset}`);
  parts.push(mod("\u{1F4B0}", v.cost, "bright_red"));
  if (results.length > 0) {
    const budgets = results.map(({ name, info }) => {
      if (!info) return `${name}: (err)`;
      return `${name}: ${fmtMoney(info.usage)} / ${fmtLimit(info.limit)}`;
    });
    parts.push(budgets.join("  "));
  }
  return parts.filter(Boolean).join("  ");
}

module.exports = async function (variables, options) {
  try {
    const v = variables || {};

    if (DEBUG_DUMP) {
      try {
        fs.appendFileSync(
          "/tmp/ccr-append-debug.log",
          `[${new Date().toISOString()}]\nvariables=${JSON.stringify(v, null, 2)}\noptions=${JSON.stringify(options, null, 2)}\n---\n`,
        );
      } catch {}
    }

    const [results] = await Promise.all([getAllBudgets()]);

    const cols = getTermCols();
    const lines = [
      formatIdentityLine(v),
      formatUsageLine(v),
      formatCostLine(v, results),
    ].filter(Boolean);

    // 每行独立按终端宽度截断，再用 \n 拼接。
    return lines.map((line) => truncateLine(line, cols)).join("\n");
  } catch {
    return "";
  }
};
