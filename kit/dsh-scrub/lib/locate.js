// dsh-scrub · 宿主定位层
// 职责：判断运行面（web / desktop）、找到 @deepseek-ai 根、把「资产 key」解析成真实文件路径。
// 与 dsh-purge 的差别：不缓存全局单例、不猜 portable 布局，只按「候选列表 + 首个存在」解析；
// 解析结果可由调用方显式传入 aiBase，便于离线审计与测试。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const isWin = process.platform === "win32";

/* ── 路径小工具 ───────────────────────────────────────────── */

export function isFile(fp) {
  try {
    return fs.statSync(fp).isFile();
  } catch {
    return false;
  }
}

export function isDir(fp) {
  try {
    return fs.statSync(fp).isDirectory();
  } catch {
    return false;
  }
}

export function firstExisting(list) {
  for (const fp of list) if (fp && isFile(fp)) return fp;
  return null;
}

export function allExisting(list) {
  const out = [];
  for (const fp of list) if (fp && isFile(fp) && !out.includes(fp)) out.push(fp);
  return out;
}

export function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

export function findDshHome() {
  const forced = process.env.DSH_HOME;
  if (forced && isDir(forced)) return path.normalize(forced);
  const guess = path.join(homeDir(), ".dsh");
  return path.normalize(guess);
}

/* ── 运行面 ───────────────────────────────────────────────── */

/** 允许 env 强指定；否则按 exe 名 / resources 布局猜。 */
export function detectSurface(env = process.env) {
  const forced = String(env.DSH_SURFACE || "").trim().toLowerCase();
  if (forced === "desktop" || forced === "web") return forced;
  if (resourcesLooksDesktop(env.DSH_APP_RESOURCES)) return "desktop";
  const exe = path.basename(String(process.execPath || "")).toLowerCase();
  if (/^deepseek[\s._-]*harness(\.exe)?$/.test(exe) || exe === "dsh desktop.exe") return "desktop";
  if (process.resourcesPath && resourcesLooksDesktop(process.resourcesPath)) return "desktop";
  return "web";
}

function resourcesLooksDesktop(dir) {
  if (!dir) return false;
  try {
    if (fs.existsSync(path.join(dir, "app", "dsh"))) return true;
    if (fs.existsSync(path.join(dir, "app.asar"))) return true;
  } catch {
    /* 无权限等：当作不是 */
  }
  return false;
}

/** 候选资源目录：env → 运行中进程 → 常见安装位。 */
export function candidateResourceDirs(env = process.env) {
  const out = [];
  const push = (d) => {
    if (!d) return;
    const n = path.normalize(d);
    if (!out.includes(n)) out.push(n);
  };
  push(env.DSH_APP_RESOURCES);
  if (process.resourcesPath) push(process.resourcesPath);
  if (process.execPath) push(path.join(path.dirname(process.execPath), "resources"));
  if (isWin) {
    push("C:\\deepseek\\resources");
    if (env.LOCALAPPDATA) {
      push(path.join(env.LOCALAPPDATA, "Programs", "DeepSeek Harness", "resources"));
      push(path.join(env.LOCALAPPDATA, "Programs", "deepseek-harness", "resources"));
    }
    if (env.ProgramFiles) push(path.join(env.ProgramFiles, "DeepSeek Harness", "resources"));
  } else {
    push("/Applications/DeepSeek Harness.app/Contents/Resources");
  }
  return out;
}

/* ── @deepseek-ai 根 ──────────────────────────────────────── */

function looksLikeAiBase(dir) {
  if (!dir) return false;
  return isDir(path.join(dir, "dsh-base")) || isDir(path.join(dir, "dsh-agent-instructions"));
}

/** 枚举所有可能的 @deepseek-ai 根（多宿主：解包目录、各 profile、pnpm 嵌套）。 */
export function findAiBases({ dshHome = findDshHome(), env = process.env } = {}) {
  const out = [];
  const push = (d) => {
    if (!d) return;
    const n = path.normalize(d);
    if (!out.includes(n) && looksLikeAiBase(n)) out.push(n);
  };

  for (const res of candidateResourceDirs(env)) {
    push(path.join(res, "app", "dsh", "node_modules", "@deepseek-ai"));
    push(path.join(res, "app.asar.unpacked", "dsh", "node_modules", "@deepseek-ai"));
  }
  push(env.DSH_BASE);

  const profiles = path.join(dshHome, "profiles");
  if (isDir(profiles)) {
    for (const name of safeReaddir(profiles)) {
      push(path.join(profiles, name, "node_modules", "@deepseek-ai"));
    }
    push(path.join(profiles, "node_modules", "@deepseek-ai"));
  }
  return out;
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

export function pickAiBase(options = {}) {
  const explicit = options.aiBase;
  if (explicit) return path.normalize(explicit);
  const list = findAiBases(options);
  return list[0] || null;
}

/* ── 资产 key → 路径 ──────────────────────────────────────── */

const pkg = (aiBase, name, ...rel) => [
  path.join(aiBase, name, ...rel),
  path.join(aiBase, "dsh", "node_modules", "@deepseek-ai", name, ...rel),
];

const piAi = (aiBase, file) => [
  path.join(aiBase, "..", "@earendil-works", "pi-ai", "dist", "api", file),
];

const shippedPreset = (aiBase, name) => [
  path.join(aiBase, "dsh-web-app", "presets", `${name}.patch.yml`),
];

function userPreset(dshHome, name) {
  return [
    path.join(dshHome, ".agent-presets", name, "agent.cordis.yml"),
    path.join(dshHome, ".agent-presets", name, "cordis.patch.yml"),
  ];
}

function desktopShell(env = process.env) {
  for (const res of candidateResourceDirs(env)) {
    const fp = path.join(res, "app", "lib", "main.js");
    if (isFile(fp)) return fp;
  }
  return null;
}

/**
 * key → 路径（字符串）或路径数组。
 * 语义与 dsh-purge 的 targetFiles 对齐：一个 key 可命中多个文件（多份候选都真实存在时全打）。
 */
export function targetFiles(aiBase, { dshHome = findDshHome(), env = process.env } = {}) {
  const one = (...cands) => firstExisting(cands.flat());
  const many = (...cands) => allExisting(cands.flat());

  return {
    "agent-instructions": one(pkg(aiBase, "dsh-agent-instructions", "lib", "index.js")),
    "agent-instructions-bootstrap": one(pkg(aiBase, "dsh-agent-instructions", "lib", "bootstrap.js")),
    "web-app": one(pkg(aiBase, "dsh-web-app", "cordis.patch.yml")),
    "web-app-lib": one(pkg(aiBase, "dsh-web-app", "lib", "index.js"), [
      path.join(aiBase, "dsh", "node_modules", "@deepseek-ai", "dsh-web-app", "lib", "index.js"),
    ]),
    headless: one(pkg(aiBase, "dsh-headless", "cordis.patch.yml")),
    "desktop-shell": desktopShell(env),
    "agent-preset": one(userPreset(dshHome, "unrestricted"), shippedPreset(aiBase, "standard")),
    "user-approval": one(pkg(aiBase, "dsh-user-approval", "lib", "types", "index.js")),
    "user-approval-code": one(pkg(aiBase, "dsh-user-approval", "lib", "index.js")),
    "user-approval-invariant": one(pkg(aiBase, "dsh-user-approval", "lib", "invariant.js")),
    escalation: many(
      pkg(aiBase, "dsh-sandbox", "lib", "index.js"),
      pkg(aiBase, "dsh-sandbox", "lib", "types", "escalation.js"),
    ),
    "fs-sandbox": one(pkg(aiBase, "dsh-fs-sandbox", "lib", "index.js")),
    "sandbox-local": one(pkg(aiBase, "dsh-sandbox-local", "lib", "index.js")),
    base: one(pkg(aiBase, "dsh-base", "cordis.patch.yml")),
    settings: one(pkg(aiBase, "dsh-settings", "lib", "index.js")),
    "fs-observation-policy": one(pkg(aiBase, "dsh-fs-observation-policy", "lib", "index.js")),
    "repeat-tool-reminder": one(pkg(aiBase, "dsh-repeat-tool-reminder", "lib", "index.js")),
    "compaction-tool-result-pruner": one(pkg(aiBase, "dsh-compaction-tool-result-pruner", "lib", "index.js")),
    "tool-fs": many(pkg(aiBase, "dsh-tool-fs", "lib", "index.js")),
    "tool-subagent": one(pkg(aiBase, "dsh-tool-subagent", "lib", "index.js")),
    subagent: many(pkg(aiBase, "dsh-subagent", "lib", "index.js")),
    "subagent-types": many(pkg(aiBase, "dsh-subagent", "lib", "types", "child-agent.js")),
    "base-package": one(pkg(aiBase, "dsh-base", "package.json")),
    "preset-unrestricted": one(userPreset(dshHome, "unrestricted")),
    "preset-standard": many(shippedPreset(aiBase, "standard")),
    "preset-cordis": many(shippedPreset(aiBase, "cordis")),
    "preset-minimal": many(shippedPreset(aiBase, "minimal")),
    "preset-ptc": many(shippedPreset(aiBase, "ptc")),
    "preset-acp-app": one(pkg(aiBase, "dsh-acp-app", "cordis.patch.yml")),
    "preset-sdk-app": one(pkg(aiBase, "dsh-sdk-app", "cordis.patch.yml")),
    "preset-sdk-minimal": one(pkg(aiBase, "dsh-sdk-minimal", "cordis.patch.yml")),
    "preset-liangshen": one(userPreset(dshHome, "liangshen"), shippedPreset(aiBase, "liangshen")),
    "preset-liangshen-pkg": one([
      path.join(aiBase, "dsh-web-app", "presets", "liangshen.package.json"),
      path.join(aiBase, "dsh-preset-liangshen", "package.json"),
    ]),
    "liangshen-tool-bootstrap": one([
      path.join(aiBase, "dsh-liangshen", "lib", "bootstrap.js"),
      path.join(aiBase, "dsh-liangshen-tool", "lib", "bootstrap.js"),
    ]),
    "tool-bash": many(pkg(aiBase, "dsh-tool-bash", "lib", "index.js")),
    "tool-pwsh": many(pkg(aiBase, "dsh-tool-pwsh", "lib", "index.js")),
    persona: one(pkg(aiBase, "dsh-persona", "lib", "index.js")),
    "session-format-v0": one(pkg(aiBase, "dsh-session-format-v0-to-v1", "lib", "index.js")),
    "system-prompt": one(pkg(aiBase, "dsh-system-prompt", "lib", "index.js")),
    "system-prompt-nested": many([
      path.join(aiBase, "dsh", "node_modules", "@deepseek-ai", "dsh-system-prompt", "lib", "index.js"),
    ]),
    "tool-web": one(pkg(aiBase, "dsh-tool-web", "lib", "index.js")),
    "tool-web-nested": many([
      path.join(aiBase, "dsh", "node_modules", "@deepseek-ai", "dsh-tool-web", "lib", "index.js"),
    ]),
    "hooks-claude-code": one(pkg(aiBase, "dsh-hooks-claude-code", "lib", "index.js")),
    "hooks-claude-code-nested": many([
      path.join(aiBase, "dsh", "node_modules", "@deepseek-ai", "dsh-hooks-claude-code", "lib", "index.js"),
    ]),
    "hooks-codex": one(pkg(aiBase, "dsh-hooks-codex", "lib", "index.js")),
    "hooks-codex-nested": many([
      path.join(aiBase, "dsh", "node_modules", "@deepseek-ai", "dsh-hooks-codex", "lib", "index.js"),
    ]),
    "api-session-controller": one(pkg(aiBase, "dsh-api-session-controller", "lib", "index.js")),
    "pi-ai-completions": one(piAi(aiBase, "openai-completions.js")),
    "pi-ai-responses-shared": one(piAi(aiBase, "openai-responses-shared.js")),
    "pi-ai-anthropic-messages": one(piAi(aiBase, "anthropic-messages.js")),
    "session-reference": many(pkg(aiBase, "dsh-session-reference", "lib", "index.js"), [
      path.join(aiBase, "dsh-session-reference", "lib", "types", "index.js"),
      path.join(aiBase, "dsh-session-reference", "lib", "types", "spill.js"),
    ]),
    "permission-presets": one(pkg(aiBase, "dsh-permission-presets", "lib", "index.js")),
    "permission-presets-types": one(pkg(aiBase, "dsh-permission-presets", "lib", "types", "index.js")),
    "session-log-deepseek": one(pkg(aiBase, "dsh-session-log-deepseek", "lib", "index.js")),
    "session-log-deepseek-types": one(pkg(aiBase, "dsh-session-log-deepseek", "lib", "types", "index.js")),
    "deliverables-prompt": one(pkg(aiBase, "dsh-client-ui-deliverables", "lib", "index.js")),
    "llm-deepseek": one(pkg(aiBase, "dsh-llm-deepseek", "lib", "index.js")),
    session: one(pkg(aiBase, "dsh-session", "lib", "index.js")),
    "agent-loop": one(pkg(aiBase, "dsh-agent-loop", "lib", "index.js")),
    "app-boot": one(pkg(aiBase, "dsh-app-boot", "lib", "index.js")),
    "conversation-client": one(pkg(aiBase, "dsh-client-ui-conversation", "lib", "client.js")),
    "tool-todo": one(pkg(aiBase, "dsh-tool-todo", "lib", "index.js")),
    "auto-review": one(pkg(aiBase, "dsh-experimental-auto-review", "lib", "index.js")),
    "dsh-tools": one(pkg(aiBase, "dsh-tools", "lib", "index.js")),
    "dsh-tools-types": one(pkg(aiBase, "dsh-tools", "lib", "types", "index.js")),
    "dsh-tools-ptc": one(pkg(aiBase, "dsh-tools", "lib", "types", "ptc.js")),
    "sandbox-policy": one(pkg(aiBase, "dsh-sandbox-policy", "lib", "index.js")),
  };
}

/** key 命中文件列表（统一成数组）。 */
export function pathsOf(files, key) {
  const v = files[key];
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

/** 所有目标文件去重列表。 */
export function flattenTargets(files) {
  const out = [];
  for (const key of Object.keys(files)) {
    for (const fp of pathsOf(files, key)) if (!out.includes(fp)) out.push(fp);
  }
  return out;
}
