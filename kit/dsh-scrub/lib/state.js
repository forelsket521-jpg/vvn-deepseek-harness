// dsh-scrub · 状态与注入文件
// 注入稿独立成文件：$DSH_HOME/dsh-scrub/prompt.md（与 dsh-purge 的 prompt-inject.md 互不干扰）。
// 首次使用从密文槽落下默认稿；用户改过就记 customized=true，恢复出厂需显式 reseed。

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { findAiBases, findDshHome, detectSurface, pickAiBase, targetFiles, pathsOf, flattenTargets } from "./locate.js";
import { allPatches, survey, tally, applyPatches, revertPatches, readManifest, scrubbedHome, bakPath } from "./engine.js";
import { defaultPrompt, normalizePrompt } from "./prompt.js";
import { SEALED_PROMPT } from "./prompt.sealed.js";
import { describe as vaultDescribe } from "./vault.js";

export { vaultDescribe };

export function scrubDir(dshHome = findDshHome()) {
  return scrubbedHome(dshHome);
}

export function promptPath(dshHome = findDshHome()) {
  return path.join(scrubbedHome(dshHome), "prompt.md");
}

export function statePath(dshHome = findDshHome()) {
  return path.join(scrubbedHome(dshHome), "state.json");
}

export function hashText(text) {
  return createHash("sha256").update(normalizePrompt(text), "utf8").digest("hex");
}

export function readState(dshHome = findDshHome()) {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(dshHome), "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

export function writeState(dshHome, patch) {
  const next = { ...readState(dshHome), ...patch, updatedAt: new Date().toISOString() };
  fs.mkdirSync(scrubbedHome(dshHome), { recursive: true });
  fs.writeFileSync(statePath(dshHome), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

/** 读注入稿；不存在则落默认稿。 */
export function readPrompt(dshHome = findDshHome()) {
  const fp = promptPath(dshHome);
  try {
    return { text: fs.readFileSync(fp, "utf8"), path: fp, seeded: false };
  } catch {
    const text = defaultPrompt();
    if (text) {
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, text, "utf8");
    }
    return { text, path: fp, seeded: true };
  }
}

export function savePrompt(dshHome, text) {
  const fp = promptPath(dshHome);
  const body = String(text ?? "");
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, body, "utf8");
  const seedHash = hashText(defaultPrompt());
  const hash = hashText(body);
  return writeState(dshHome, { customized: hash !== seedHash, hash, seedHash, bytes: body.length });
}

export function reseedPrompt(dshHome) {
  return savePrompt(dshHome, defaultPrompt());
}

/** 从 dsh-purge 的注入文件迁移（可选，保留用户已改的正文）。 */
export function importFromPurge(dshHome = findDshHome()) {
  const legacy = path.join(dshHome, "prompt-inject.md");
  try {
    const text = fs.readFileSync(legacy, "utf8");
    if (!normalizePrompt(text)) return { ok: false, reason: "legacy file empty" };
    savePrompt(dshHome, text);
    return { ok: true, bytes: text.length, from: legacy };
  } catch {
    return { ok: false, reason: "prompt-inject.md not found" };
  }
}

/* ── 汇总状态 ─────────────────────────────────────────────── */

export async function gatherState({
  aiBase = null,
  dshHome = findDshHome(),
  surface = detectSurface(),
  ids = null,
  includeFiles = true,
} = {}) {
  const bases = findAiBases({ dshHome });
  const base = aiBase || pickAiBase({ dshHome });
  const files = base ? targetFiles(base, { dshHome }) : null;
  const rows = base ? await survey({ aiBase: base, dshHome, surface, ids, files }) : [];
  const prompt = readPrompt(dshHome);
  const st = readState(dshHome);
  const manifest = await readManifest(dshHome, 30);
  const allTargets = files ? flattenTargets(files) : [];
  const backups = allTargets.filter((fp) => fs.existsSync(bakPath(fp)));

  return {
    surface,
    dsh_home: dshHome,
    ai_base: base,
    ai_bases: bases,
    prompt: {
      path: prompt.path,
      bytes: prompt.text.length,
      seeded: prompt.seeded,
      customized: Boolean(st.customized),
      hash: st.hash || hashText(prompt.text),
      seed_hash: st.seedHash || hashText(defaultPrompt()),
      vault: vaultDescribe(SEALED_PROMPT),
    },
    counts: tally(rows),
    rows: includeFiles ? rows : rows.map(({ files: _f, ...rest }) => rest),
    targets: allTargets.length,
    backups: backups.length,
    backup_files: backups,
    manifest,
    patches_meta: allPatches().length,
  };
}

/* ── 操作 ─────────────────────────────────────────────────── */

export async function opApply({ aiBase, dshHome = findDshHome(), surface = detectSurface(), ids = [], dryRun = false } = {}) {
  const base = aiBase || pickAiBase({ dshHome });
  if (!base) return { ok: false, error: "找不到 @deepseek-ai 根，无法打补丁" };
  const prompt = readPrompt(dshHome);
  if (!normalizePrompt(prompt.text)) return { ok: false, error: "注入稿为空，先写一份再打补丁" };
  const res = await applyPatches({ aiBase: base, dshHome, surface, ids: ids.length ? ids : null, dryRun });
  const rows = await survey({ aiBase: base, dshHome, surface });
  return { ok: true, ...res, counts: tally(rows) };
}

export async function opRevert({ aiBase, dshHome = findDshHome(), ids = [] } = {}) {
  const base = aiBase || pickAiBase({ dshHome });
  if (!base) return { ok: false, error: "找不到 @deepseek-ai 根" };
  const res = await revertPatches({ aiBase: base, dshHome, ids: ids.length ? ids : null });
  return { ok: true, ...res };
}

export function pathsFor(key, aiBase = pickAiBase()) {
  if (!aiBase) return [];
  return pathsOf(targetFiles(aiBase), key);
}
