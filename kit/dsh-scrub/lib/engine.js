// dsh-scrub · 执行引擎
// 职责：把 TABLE 里的 needle 打到宿主文件上，并给出可解释的状态。
// 设计取向（与 dsh-purge 的差别）：
//   1. 纯数据 + 纯函数：apply 不读全局状态，宿主路径由调用方传入；
//   2. 一切写盘先走 dry-run 计算，dry-run 与实际写盘共用同一份 diff；
//   3. 备份后缀 .scrbak + 一份 manifest，回滚可逐条、可审计；
//   4. 状态四态：applied / pending / skipped / missing，na 由 surfaces 判定单独给。

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { TABLE } from "./table.data.js";
import { findDshHome, pathsOf, targetFiles } from "./locate.js";

export const BAK_SUFFIX = ".scrbak";

/* ── 补丁规范化 ───────────────────────────────────────────── */

const LAYOUT_SOFT_IDS = new Set([4, 25, 26, 5, 11, 12]);

function toRegExp(spec) {
  if (spec && typeof spec === "object" && typeof spec.re === "string") {
    return new RegExp(spec.re, String(spec.flags || "").replace(/g/g, ""));
  }
  return spec;
}

const PATCHES = TABLE.map((raw) => ({
  ...raw,
  needles: (raw.replacements || []).map((r) => ({
    pattern: toRegExp(r.pattern),
    replace: String(r.replace ?? ""),
  })),
  keys: Array.isArray(raw.file) ? raw.file : [raw.file],
  soft: Boolean(raw.softSettle) || LAYOUT_SOFT_IDS.has(raw.id),
}));

export function allPatches() {
  return PATCHES;
}

export function patchById(id) {
  return PATCHES.find((p) => p.id === Number(id)) || null;
}

export function appliesOnSurface(patch, surface = "web") {
  const want = patch.surfaces;
  if (!Array.isArray(want) || want.length === 0) return true;
  const adapter = surface === "desktop" ? "desktop" : "web";
  return want.includes(adapter) || want.includes(surface);
}

/* ── 文本工具 ─────────────────────────────────────────────── */

export const lf = (s) => String(s ?? "").replace(/\r\n/g, "\n");

function isYaml(fp) {
  return /\.(ya?ml)$/i.test(String(fp || ""));
}

/** YAML 里行尾 `//` 注释会被当成标量内容，换成 `#`；!!js 表达式行原样保留。 */
export function yamlCommentFix(text) {
  return lf(text)
    .split("\n")
    .map((line) => {
      if (line.includes("!!js")) return line;
      let quote = "";
      for (let i = 0; i < line.length - 1; i += 1) {
        const ch = line[i];
        if (quote) {
          if (quote === '"' && ch === "\\") { i += 1; continue; }
          if (ch === quote) quote = "";
          continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; continue; }
        if (ch === "#") return line;
        if (ch === "/" && line[i + 1] === "/" && (i === 0 || /\s/.test(line[i - 1]))) {
          return `${line.slice(0, i)}#${line.slice(i + 2)}`;
        }
      }
      return line;
    })
    .join("\n");
}

const BARE_IDENTITY = /^You are a coding agent powered by\b/;

function skipNeedleInYaml(pattern) {
  return typeof pattern === "string" && !/^[ \t]/.test(pattern) && BARE_IDENTITY.test(pattern);
}

function needleHits(hay, pattern) {
  if (pattern instanceof RegExp) return new RegExp(pattern.source, pattern.flags.replace(/g/g, "")).test(hay);
  return hay.includes(lf(pattern));
}

/* ── marker / 完成度判定 ──────────────────────────────────── */

export function markerState(text, patch) {
  const hay = lf(text);
  if (Array.isArray(patch.forbid) && patch.forbid.some((m) => hay.includes(lf(m)))) {
    return { ok: false, detailed: patch.forbid.map(() => false), matched: 0 };
  }
  const list = patch.markers || (patch.marker ? [patch.marker] : []);
  if (list.length === 0) return { ok: false, detailed: [], matched: 0 };
  const detailed = list.map((m) => hay.includes(lf(m)));
  const ok = patch.markersAny ? detailed.some(Boolean) : detailed.every(Boolean);
  return { ok, detailed, matched: detailed.filter(Boolean).length };
}

export function remainingNeedles(text, patch, fp = "") {
  const hay = lf(text);
  const out = [];
  patch.needles.forEach((n, i) => {
    if (isYaml(fp) && skipNeedleInYaml(n.pattern)) return;
    if (needleHits(hay, n.pattern)) out.push(i + 1);
  });
  return out;
}

/** 这条补丁在这个文件上算不算完成。 */
export function settled(text, patch, fp = "") {
  const mk = markerState(text, patch);
  if (mk.ok) return true;
  if (patch.soft) return remainingNeedles(text, patch, fp).length === 0;
  return false;
}

/** applied / pending / skipped：文件内的单点结论。 */
export function fileVerdict(text, patch, fp = "") {
  if (settled(text, patch, fp)) return "applied";
  if (remainingNeedles(text, patch, fp).length > 0) return "pending";
  return "skipped";
}

/* ── 替换 ─────────────────────────────────────────────────── */

export function rewrite(text, patch, fp = "") {
  const original = String(text ?? "");
  let out = lf(original);
  let changed = false;

  if (patch.skipIfMarked && markerState(out, patch).ok) {
    return { text: original, changed: false, replaced: [] };
  }

  const replaced = [];
  patch.needles.forEach((n, idx) => {
    if (isYaml(fp) && skipNeedleInYaml(n.pattern)) return;
    const body = isYaml(fp) ? yamlCommentFix(n.replace) : lf(n.replace);
    if (n.pattern instanceof RegExp) {
      const re = new RegExp(n.pattern.source, `${n.pattern.flags.replace(/g/g, "")}g`);
      if (!re.test(out)) return;
      re.lastIndex = 0;
      const next = out.replace(re, body);
      if (next === out) return;
      out = next;
      changed = true;
      replaced.push(idx + 1);
      return;
    }
    const needle = lf(n.pattern);
    if (!needle || !out.includes(needle)) return;
    const next = out.split(needle).join(body);
    if (next === out) return;
    out = next;
    changed = true;
    replaced.push(idx + 1);
  });

  if (changed && original.includes("\r\n")) out = out.replace(/\n/g, "\r\n");
  return { text: changed ? out : original, changed, replaced };
}

/* ── 落盘 ─────────────────────────────────────────────────── */

export function scrubbedHome(dshHome = findDshHome()) {
  const dir = path.join(dshHome, "dsh-scrub");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function bakPath(fp) {
  return `${fp}${BAK_SUFFIX}`;
}

export function sha256(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

/** 原子写：同目录写 tmp → rename；内容相同则不写。 */
export async function writeAtomic(fp, text) {
  const next = Buffer.from(text, "utf8");
  let current = null;
  try {
    current = await fs.promises.readFile(fp);
  } catch (e) {
    if (!e || e.code !== "ENOENT") throw e;
  }
  if (current && current.equals(next)) return false;
  const dir = path.dirname(fp);
  const tmp = path.join(dir, `.${path.basename(fp)}.${process.pid}.${Date.now()}.scrtmp`);
  await fs.promises.mkdir(dir, { recursive: true });
  let mode = 0o644;
  try { mode = (await fs.promises.stat(fp)).mode; } catch { /* 新文件用默认 */ }
  await fs.promises.writeFile(tmp, next, { mode });
  try {
    await fs.promises.rename(tmp, fp);
  } catch (e) {
    try { await fs.promises.unlink(tmp); } catch { /* ignore */ }
    throw e;
  }
  return true;
}

async function backupOnce(fp, text) {
  const bak = bakPath(fp);
  if (fs.existsSync(bak)) return "kept";
  await writeAtomic(bak, text);
  return "created";
}

/* ── 状态巡检 ─────────────────────────────────────────────── */

export async function survey({ aiBase, dshHome = findDshHome(), surface = "web", ids = null, files = null } = {}) {
  const map = files || targetFiles(aiBase, { dshHome });
  const want = ids ? new Set(ids.map(Number)) : null;
  const rows = [];

  for (const patch of PATCHES) {
    if (want && !want.has(patch.id)) continue;
    if (!appliesOnSurface(patch, surface)) {
      rows.push(baseRow(patch, "na", []));
      continue;
    }
    const seen = [];
    for (const key of patch.keys) {
      const list = pathsOf(map, key);
      if (list.length === 0) {
        seen.push({ key, path: null, status: "missing", markers: [], needles: { total: patch.needles.length, pending: 0 } });
        continue;
      }
      for (const fp of list) {
        let text;
        try {
          text = await fs.promises.readFile(fp, "utf8");
        } catch {
          seen.push({ key, path: fp, status: "unreadable", markers: [], needles: { total: patch.needles.length, pending: 0 } });
          continue;
        }
        const mk = markerState(text, patch);
        const remaining = remainingNeedles(text, patch, fp);
        seen.push({
          key,
          path: fp,
          bytes: text.length,
          backup: fs.existsSync(bakPath(fp)),
          status: fileVerdict(text, patch, fp),
          markers: mk.detailed,
          markersAny: Boolean(patch.markersAny),
          needles: { total: patch.needles.length, pending: remaining.length, pendingIdx: remaining },
        });
      }
    }
    rows.push(baseRow(patch, rollup(seen, patch), seen));
  }
  return rows;
}

function baseRow(patch, status, files) {
  return {
    id: patch.id,
    name: patch.name,
    layer: patch.layer,
    desc: patch.desc || "",
    optional: Boolean(patch.optional),
    soft: patch.soft,
    surfaces: patch.surfaces || null,
    status,
    files,
  };
}

function rollup(seen, patch) {
  if (seen.length === 0) return patch.optional ? "na" : "missing";
  const s = seen.map((x) => x.status);
  if (s.includes("pending")) return "pending";
  if (s.includes("applied")) return "applied";
  if (s.includes("unreadable")) return "unreadable";
  if (s.every((x) => x === "missing")) return patch.optional ? "na" : "missing";
  if (s.includes("skipped")) return "skipped";
  return "skipped";
}

export function tally(rows) {
  const out = { total: rows.length, applied: 0, pending: 0, skipped: 0, missing: 0, na: 0, unreadable: 0 };
  for (const r of rows) out[r.status] = (out[r.status] || 0) + 1;
  return out;
}

/* ── 应用 ─────────────────────────────────────────────────── */

/**
 * @returns {{rows: Array, written: Array, already: number, failed: Array, dryRun: boolean}}
 */
export async function applyPatches({
  aiBase,
  dshHome = findDshHome(),
  surface = "web",
  ids = null,
  dryRun = true,
  backup = true,
  files = null,
} = {}) {
  const map = files || targetFiles(aiBase, { dshHome });
  const want = ids ? new Set(ids.map(Number)) : null;
  const report = [];
  const written = [];
  const failed = [];
  let already = 0;

  for (const patch of PATCHES) {
    if (want && !want.has(patch.id)) continue;
    if (!appliesOnSurface(patch, surface)) {
      report.push({ ...baseRow(patch, "na", []), action: "na" });
      continue;
    }
    const touches = [];
    let action = "noop";
    for (const key of patch.keys) {
      for (const fp of pathsOf(map, key)) {
        let text;
        try {
          text = await fs.promises.readFile(fp, "utf8");
        } catch (e) {
          failed.push({ id: patch.id, path: fp, error: `read: ${e.message}` });
          continue;
        }
        const res = rewrite(text, patch, fp);
        if (!res.changed) {
          const verdict = fileVerdict(text, patch, fp);
          touches.push({ path: fp, key, action: verdict === "applied" ? "already" : verdict, delta: 0 });
          if (verdict === "applied") already += 1;
          continue;
        }
        const delta = res.text.length - text.length;
        if (dryRun) {
          touches.push({ path: fp, key, action: "would-write", delta, replaced: res.replaced });
          action = "would-write";
          continue;
        }
        try {
          if (backup) await backupOnce(fp, text);
          const ok = await writeAtomic(fp, res.text);
          touches.push({ path: fp, key, action: ok ? "written" : "already", delta, replaced: res.replaced });
          if (ok) {
            written.push({ path: fp, key, id: patch.id, delta, sha256: sha256(res.text) });
            action = "written";
          }
        } catch (e) {
          failed.push({ id: patch.id, path: fp, error: `write: ${e.message}` });
        }
      }
    }
    report.push({ ...baseRow(patch, action === "would-write" ? "pending" : "applied", []), action, files: touches });
  }

  if (!dryRun && written.length) await appendManifest(dshHome, written, { aiBase, surface });
  return { rows: report, written, already, failed, dryRun };
}

/* ── 回滚 ─────────────────────────────────────────────────── */

export async function revertPatches({ aiBase, dshHome = findDshHome(), ids = null, files = null } = {}) {
  const map = files || targetFiles(aiBase, { dshHome });
  const want = ids ? new Set(ids.map(Number)) : null;
  const restored = [];
  const missing = [];
  const seen = new Set();

  const targets = [];
  for (const patch of PATCHES) {
    if (want && !want.has(patch.id)) continue;
    for (const key of patch.keys) for (const fp of pathsOf(map, key)) if (!seen.has(fp)) { seen.add(fp); targets.push(fp); }
  }

  for (const fp of targets) {
    const bak = bakPath(fp);
    if (!fs.existsSync(bak)) {
      if (fs.existsSync(fp)) missing.push(fp);
      continue;
    }
    try {
      const text = await fs.promises.readFile(bak, "utf8");
      await writeAtomic(fp, text);
      restored.push(fp);
    } catch (e) {
      missing.push(`${fp} (${e.message})`);
    }
  }

  if (restored.length) await appendManifest(dshHome, restored.map((p) => ({ path: p, action: "revert" })), {});
  return { restored, withoutBackup: missing };
}

/* ── manifest（审计） ─────────────────────────────────────── */

async function appendManifest(dshHome, entries, meta) {
  const dir = scrubbedHome(dshHome);
  const fp = path.join(dir, "manifest.jsonl");
  const line = JSON.stringify({ at: new Date().toISOString(), ...meta, entries });
  await fs.promises.appendFile(fp, `${line}\n`, "utf8");
}

export async function readManifest(dshHome = findDshHome(), limit = 200) {
  const fp = path.join(scrubbedHome(dshHome), "manifest.jsonl");
  let raw = "";
  try { raw = await fs.promises.readFile(fp, "utf8"); } catch { return []; }
  const lines = raw.split("\n").filter(Boolean);
  return lines.slice(-limit).map((l) => {
    try { return JSON.parse(l); } catch { return { malformed: l }; }
  });
}
