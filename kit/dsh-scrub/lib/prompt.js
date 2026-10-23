// dsh-scrub · 提示词整形层
// 目标：把 prompt-inject.md 的正文安全地塞进 DSH 的 system prompt 段，且不被官方段落挤掉或吃掉。
// 四道必备处理（缺一段就整段失效或人格穿透）：
//   1. ChatML 信封规范化：<|im_start|>system:<project_instructions> 必须分行 + 闭合；
//   2. 插值转义：DSH 只认 {{cwd}}/{{model}}/{{provider}}，其它 {{…}} 会让整段抛 malformed；
//   3. 身份剥离：删掉官方「你是 DeepSeek Harness 的 AI agent」类句子；
//   4. 模式剪裁：极简预设去掉 STRICT 工具块，红队会话去掉 CTF 契约。

import { SEALED_PROMPT } from "./prompt.sealed.js";
import { openSealed } from "./vault.js";

export const SECTIONS = Object.freeze({
  CORE: "scrub-core",
  CAPS: "scrub-caps",
  TAIL: "scrub-tail",
});

const INTERP_OK = new Set(["cwd", "model", "provider"]);

/* ── 1. ChatML 信封 ───────────────────────────────────────── */

const CHATML = "<|im_start|>system:";
const OPEN = "<project_instructions>";
const CLOSE = "</project_instructions>";

export function normalizeEnvelope(text) {
  let out = String(text ?? "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!out) return out;
  out = out.replace(/<\|im_start\|>\s*system\s*:\s*<project_instructions>/gi, `${CHATML}\n${OPEN}`);
  out = out.replace(/<\|im_start\|>\s*system\s*:(?!\s*\n)/gi, `${CHATML}\n`);
  out = out.replace(/<\|im_start\|>system:\n+<project_instructions>/i, `${CHATML}\n${OPEN}`);
  if (/<project_instructions>/i.test(out) && !/<\/project_instructions>/i.test(out)) {
    out = `${out.replace(/\s+$/, "")}\n${CLOSE}`;
  }
  return out.replace(/[ \t]+$/gm, "").replace(/^\s+/, "").replace(/\s+$/, "");
}

/** 官方段里漏进来的信封标签拆掉，避免出现第二套未闭合标签。 */
export function stripEnvelopeTags(text) {
  return String(text ?? "")
    .replace(/<\|im_start\|>\s*system\s*:\s*/gi, "")
    .replace(/<\/?project_instructions>/gi, "")
    .replace(/<\|im_end\|>/g, "");
}

/* ── 2. 插值转义 ──────────────────────────────────────────── */

export function escapeInterpolation(text) {
  const src = String(text ?? "");
  if (!src.includes("{{")) return src;
  return src.replace(/\{\{([^{}]*)\}\}|(\{\{)/g, (all, name, open) => {
    if (name !== undefined && INTERP_OK.has(name.trim())) return all;
    if (open) return "{ {";
    return `{ {${name}}}`;
  });
}

/* ── 3. 身份剥离 ──────────────────────────────────────────── */

const IDENTITY_PATTERNS = [
  /You are an AI agent powered by DeepSeek Harness\.?\s*/g,
  /You are a helpful software engineer assistant\.?\s*/gi,
  /你是一个有帮助的软件工程师助手[。.]?\s*/g,
  /我是 DeepSeek(?:驱动)?的? ?AI(?:编程)?助手[，,]?[^\n]*/g,
  /你好！?我是 DeepSeek[^\n]*/g,
  /You are interacting with the user through the DeepSeek Harness Web GUI/g,
];

export function stripIdentity(text) {
  let out = String(text ?? "");
  for (const re of IDENTITY_PATTERNS) out = out.replace(re, "");
  out = out.replace(
    /You are interacting with the user through the local web GUI at (\S+)\. /g,
    "Local web GUI: $1. ",
  );
  return out.replace(/\n{3,}/g, "\n\n");
}

/* ── 4a. 极简预设：去掉 STRICT 工具块 ─────────────────────── */

const STRICT_TITLE = "STRICT REQUIREMENT — MUST USE";
const RULE_FENCE = "\n═══════════════════════════════════════";

function rewriteClaudeTools(text) {
  return String(text ?? "")
    .replace(/Always use apply_patch for manual code edits\.[^\n]*/gi,
      "Edits: use `edit` / `write` when available; otherwise the persistent shell.")
    .replace(/Do not use Python to read\/write files when a simple shell command or apply_patch would suffice\./gi,
      "Prefer `read`/`write`/`edit` or the persistent shell for file I/O.")
    .replace(/Use `multi_tool_use\.parallel` to parallelize tool calls and only this\.[^\n]*/gi,
      "Issue independent tool calls in the same step.");
}

export function clipStrictBlock(text) {
  const raw = String(text ?? "");
  if (!raw.trim()) return raw;
  const at = raw.indexOf(STRICT_TITLE);
  if (at < 0) return rewriteClaudeTools(raw);

  let start = at;
  const prevLine = raw.lastIndexOf("\n", at - 1);
  if (prevLine >= 0) {
    const deco = raw.lastIndexOf("\n", prevLine - 1) + 1;
    if (/[═]{6,}/.test(raw.slice(deco, prevLine))) start = deco;
  }
  const job = raw.indexOf("\n# 全局作业", at);
  let scan = at + STRICT_TITLE.length;
  const titleNl = raw.indexOf("\n", at);
  if (titleNl >= 0) {
    const ul = raw.indexOf("\n", titleNl + 1);
    if (ul >= 0 && /[═]{6,}/.test(raw.slice(titleNl + 1, ul))) scan = ul;
  }
  const nextFence = raw.indexOf(RULE_FENCE, scan);
  let end = raw.length;
  if (job >= 0) end = job;
  else if (nextFence >= 0) end = nextFence;

  const kept = `${raw.slice(0, start).replace(/\s+$/u, "")}\n\n${raw.slice(end).replace(/^\s+/u, "")}`;
  return rewriteClaudeTools(kept);
}

/* ── 4b. 红队会话：去掉 CTF 契约 ──────────────────────────── */

export function clipCtfContract(text) {
  const raw = String(text ?? "");
  const at = raw.indexOf("CTF Core Contract");
  if (at < 0) return raw;
  const head = raw.slice(0, at);
  const titleLine = head.lastIndexOf("\n", at - 1);
  const fenceAt = head.lastIndexOf("═══", at);
  const from = fenceAt >= 0 ? head.lastIndexOf("\n", fenceAt) + 1 : Math.max(titleLine, 0);
  const after = raw.indexOf("\n═══════════════════════════════════════", at + 10);
  const end = after >= 0 ? after : raw.length;
  return `${raw.slice(0, from).replace(/\s+$/u, "")}\n\n${raw.slice(end).replace(/^\s+/u, "")}`;
}

/* ── 能力选用协议（三种角色） ─────────────────────────────── */

const CAPS_MAIN = `## 能力选用（必做）
1. 先读：本会话的 skill 目录、已挂 MCP / 宿主工具清单，读清楚再动手。
2. 再配：按**当前这一单**挑 skill 与工具，不无脑全用，也不刻意不用。
3. 后调：命中 skill 就用 \`skill\` 载入并按它的方法走；命中 MCP/CLI 就按真实 schema 调；失败按其语义处理，不硬编替代品。
4. 兜底：目录里确实没有对口能力，再用 shell / 临时脚本，并在回复里说明缺的是什么。
5. 委派：任何子代理的 brief 里都要写上「先读目录、按任务挑能力」这条要求。
6. 本段不摘除任何已挂能力。`;

const CAPS_REDTEAM_LEAD = `## 能力选用（演练台主控）
1. 你的活是：定计划 → 派单（\`subagent\`）→ 验收 → 汇总。落地动作交给执行者。
2. 派单前先确认下一阶段该用哪个 skill / MCP，写进 brief。
3. brief 必须点名能力（写得出的直接写 skill 名），禁止「你去查一下」这种空单。
4. 子代理的 skill / MCP 一律不禁用；只对「继续往下派」的工具设限。
5. 回到主控视角看结果，不复述子代理的中间过程。`;

const CAPS_REDTEAM_CHILD = `## 能力选用（演练台执行者）
1. 先读 \`<available_skills>\` 与你的角色技能，再看可用 MCP/CLI。
2. 按**派给你的那一单**挑能力，不多不少。
3. 命中就调：skill 用 \`skill\`，MCP 按 schema。
4. 只在目录没有覆盖时自己写脚本；留在角色内，不再往下派单。`;

export function capsText({ role = "main" } = {}) {
  if (role === "redteam") return CAPS_REDTEAM_LEAD;
  if (role === "redteam-child") return CAPS_REDTEAM_CHILD;
  return CAPS_MAIN;
}

/* ── 默认稿 / 全流程 ──────────────────────────────────────── */

let cachedDefault = null;

export function defaultPrompt() {
  if (cachedDefault === null) cachedDefault = openSealed(SEALED_PROMPT);
  return cachedDefault;
}

export function normalizePrompt(text) {
  return String(text ?? "").replace(/\r\n/g, "\n").trim();
}

/**
 * 完整整形：正文 → 线上可用的 system prompt 段。
 * @param {string} text prompt-inject.md 正文（或默认稿）
 * @param {{ preset?: string, redteam?: boolean, minimal?: boolean }} mode
 */
export function shapePrompt(text, mode = {}) {
  let body = normalizePrompt(text);
  if (!body) return "";
  body = stripIdentity(body);
  body = mode.redteam ? clipCtfContract(body) : body;
  if (mode.minimal) body = clipStrictBlock(body);
  body = normalizeEnvelope(body);
  return escapeInterpolation(body);
}

export function isMinimalPreset(name) {
  const n = String(name ?? "").toLowerCase();
  if (!n) return false;
  return n === "minimal" || n === "sdk-minimal" || n.endsWith("/minimal") || n.includes("preset-minimal");
}

export function isRedteamPreset(name) {
  const n = String(name ?? "").trim();
  if (!n) return false;
  if (/^red[\s_-]*team$/i.test(n)) return true;
  return n.replace(/不是红队|非红队/g, "").includes("红队");
}
