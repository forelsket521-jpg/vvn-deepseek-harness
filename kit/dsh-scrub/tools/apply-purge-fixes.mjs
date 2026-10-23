// 给 dsh-purge 打三处修复（幂等；升级/重装后重跑即可）
//   FIX-1 用户稿判据：looksLikePluginDefault 改用 state.hash，不再用文本标记猜
//   FIX-2 部分命中可见：默认只统计不拦（升级链不能被误伤），blockPartial 才拒写
//   FIX-3 只读诊断：core.partialReport() + CLI --status 底部列出"打不全"的补丁
// 用法：node tools/apply-purge-fixes.mjs [--dry]
import fs from "node:fs";
import path from "node:path";

const PKG = process.env.PURGE_PKG || "C:/Users/Administrator/.dsh/profiles/desktop/node_modules/dsh-purge";
const CORE = "lib/core.js";
const BIN = "bin/dsh-purge.js";
const dry = process.argv.includes("--dry");

const FIXES = [
  /* ── FIX-1 用户稿判据 ───────────────────────────────── */
  {
    id: "FIX-1a", file: CORE, name: "looksLikePluginDefault 改用 state.hash",
    marker: "export function looksLikePluginDefault(text, dshHome) {",
    from: `export function looksLikePluginDefault(text) {
  const n = normalizeOverride(text);
  if (!n) return false;
  if (n === normalizeOverride(defaultOverrideText())) return true;
  return PLUGIN_DEFAULT_MARKS.every((mark) => n.includes(mark));
}`,
    to: `export function looksLikePluginDefault(text, dshHome) {
  const n = normalizeOverride(text);
  if (!n) return false;
  if (n === normalizeOverride(defaultOverrideText())) return true;

  let home = dshHome;
  if (!home) {
    try { home = findDshHome(); } catch { home = ""; }
  }
  if (home) {
    let state = null;
    try { state = readOverrideStateSync(home); } catch { state = null; }
    if (state && (typeof state.hash === "string" || typeof state.seedHash === "string")) {
      return overrideTextIsOurs(state, text);
    }
  }
  const head = n.slice(0, 400);
  return PLUGIN_DEFAULT_MARKS.every((mark) => head.includes(mark));
}`,
  },
  {
    id: "FIX-1b", file: CORE, name: "isKeepableUserOverride 传 home",
    marker: "if (looksLikePluginDefault(text, dshHome)) return false;",
    from: `  if (incoming === normalizeOverride(defaultOverrideText())) return false;
  if (looksLikePluginDefault(text)) return false;`,
    to: `  if (incoming === normalizeOverride(defaultOverrideText())) return false;
  if (looksLikePluginDefault(text, dshHome)) return false;`,
  },
  {
    id: "FIX-1c", file: CORE, name: "installOverride 传 home",
    marker: "&& !looksLikePluginDefault(disk, dshHome)",
    from: `    && !overrideTextIsOurs(state, disk)
    && !looksLikePluginDefault(disk)`,
    to: `    && !overrideTextIsOurs(state, disk)
    && !looksLikePluginDefault(disk, dshHome)`,
  },

  /* ── FIX-2 部分命中可见 ─────────────────────────────── */
  {
    id: "FIX-2a", file: CORE, name: "新增 needleHitStats",
    marker: 'function needleHitStats(text, patch, fp = "") {',
    from: `function cloneRegExp(pattern, global) {`,
    to: `/**
 * 这条补丁在这个文件上"命中几条 needle / 一共几条"。
 * 只用于诊断与可选严格模式：replacements 同时承担"升级链（互斥变体）"
 * 与"多处替换"两种语义，hit < total 本身不能断言写坏了。
 */
function needleHitStats(text, patch, fp = "") {
  const hay = asLf(text);
  const yaml = isYamlPath(fp);
  let hit = 0;
  let total = 0;
  for (const { pattern, replace } of patchReplacements(patch)) {
    if (!pattern || typeof replace !== "string") continue;
    if (yaml && isBareIdentityNeedle(pattern)) continue;
    total += 1;
    if (matchesPattern(hay, pattern)) hit += 1;
  }
  return { hit, total };
}

function cloneRegExp(pattern, global) {`,
  },
  {
    id: "FIX-2b", file: CORE, name: "rollupPatchStatus 接受 partial",
    marker: 'if (partial > 0) return "partial_blocked";',
    from: `function rollupPatchStatus({ applied, already, missing, notFound, lastError, keyCount, layoutSoft, strictFiles }) {
  if (strictFiles && lastError) return lastError;
  if (strictFiles && notFound > 0) return "pattern_not_found";
  if (applied > 0) return "applied";`,
    to: `function rollupPatchStatus({ applied, already, missing, notFound, partial, lastError, keyCount, layoutSoft, strictFiles }) {
  if (strictFiles && lastError) return lastError;
  if (strictFiles && notFound > 0) return "pattern_not_found";
  // 仅在 blockPartial 严格模式下才会累加 partial。
  if (partial > 0) return "partial_blocked";
  if (applied > 0) return "applied";`,
  },
  {
    id: "FIX-2c", file: CORE, name: "applyPatches 计数器",
    marker: "    let partialSeen = 0;",
    from: `    let notFound = 0;
    let lastError = null;`,
    to: `    let notFound = 0;
    let partial = 0;
    let partialSeen = 0;
    let lastError = null;`,
  },
  {
    id: "FIX-2d", file: CORE, name: "applyPatches 部分命中统计",
    marker: "const isPartial = stat.total > 1",
    from: `        const appliedText = applyReplacementsToText(text, p, fp);
        let textOut = appliedText.text;`,
    to: `        // 部分命中：默认只统计、不拦。
        // replacements 同时是"升级链"（互斥历史写法，命中一条即正确）与"多处替换"，
        // 数据没有分组信息，强拦会误伤升级链（#1 有 6 条、#42 有 12 条）。
        // 需要严格模式时传 options.blockPartial = true。
        {
          const stat = needleHitStats(text, p, fp);
          const isPartial = stat.total > 1 && stat.hit > 0 && stat.hit < stat.total;
          if (isPartial) {
            partialSeen += 1;
            if (options.blockPartial === true) {
              partial += 1;
              continue;
            }
          }
        }
        const appliedText = applyReplacementsToText(text, p, fp);
        let textOut = appliedText.text;`,
  },
  {
    id: "FIX-2e", file: CORE, name: "报告里带 partial 计数",
    marker: "partial_blocked: partial,",
    from: `    const status = rollupPatchStatus({
      applied, already, missing, notFound, lastError, keyCount: keys.length,
      layoutSoft: isLayoutSoftPatch(p),
      strictFiles: !!p.strictFiles,
    });
    report.push({
      patch_id: p.id,
      name: p.name,
      status,
      path: paths[0] || files[keys[0]],
      applied,
      already,
      missing,
    });`,
    to: `    const status = rollupPatchStatus({
      applied, already, missing, notFound, partial, lastError, keyCount: keys.length,
      layoutSoft: isLayoutSoftPatch(p),
      strictFiles: !!p.strictFiles,
    });
    report.push({
      patch_id: p.id,
      name: p.name,
      status,
      path: paths[0] || files[keys[0]],
      applied,
      already,
      missing,
      partial: partialSeen,
      partial_blocked: partial,
    });`,
  },

  /* ── FIX-3 只读诊断 ─────────────────────────────────── */
  {
    id: "FIX-3a", file: CORE, name: "新增 partialReport()",
    marker: "export async function partialReport(aiBase, patches = ALL_PATCHES) {",
    from: `export async function hasBackup(aiBase) {
  const files = targetFiles(aiBase);`,
    to: `/**
 * 只读诊断：列出"needle 只命中一部分"的补丁。
 * 状态页只有 applied/pending 两态，看不出"打不动"和"还没打"的区别，这里分开。
 */
export async function partialReport(aiBase, patches = ALL_PATCHES) {
  if (!aiBase) return [];
  const files = targetFiles(aiBase);
  const out = [];
  for (const p of patches) {
    if (!patchAppliesHere(p)) continue;
    for (const key of fileKeysOf(p)) {
      for (const fp of pathsOf(files, key)) {
        let text;
        try {
          text = await loadText(fp);
        } catch {
          continue;
        }
        const stat = needleHitStats(text, p, fp);
        if (stat.total > 0 && stat.hit > 0 && stat.hit < stat.total) {
          out.push({ id: p.id, name: p.name, path: fp, hit: stat.hit, total: stat.total });
        }
      }
    }
  }
  return out;
}

export async function hasBackup(aiBase) {
  const files = targetFiles(aiBase);`,
  },
  {
    id: "FIX-3b", file: BIN, name: "CLI --status 列出部分命中",
    marker: "⚠ 部分命中（apply 会拒写",
    from: `  out.push("");
  out.push(\`  shim: dsh.cmd=\${state.shim_cmd}  dsh.ps1=\${state.shim_ps1}  dsh=\${state.shim_bin}\`);
  return out.join("\\n");`,
    to: `  out.push("");
  out.push(\`  shim: dsh.cmd=\${state.shim_cmd}  dsh.ps1=\${state.shim_ps1}  dsh=\${state.shim_bin}\`);
  if (Array.isArray(state.partial) && state.partial.length) {
    out.push("");
    out.push("  ⚠ 部分命中（needle 需按当前宿主版本更新；严格模式 blockPartial 会拒写）:");
    for (const x of state.partial) {
      out.push(\`    [#\${String(x.id).padEnd(2)}] \${x.name.padEnd(36)} \${x.hit}/\${x.total}  \${x.path}\`);
    }
  }
  return out.join("\\n");`,
  },
  {
    id: "FIX-3c", file: BIN, name: "CLI 收集 partial",
    marker: "state.partial = typeof core.partialReport",
    from: `  const state = await core.gatherState();
  console.log(printStatus(state));`,
    to: `  const state = await core.gatherState();
  state.partial = typeof core.partialReport === "function"
    ? await core.partialReport(state.ai_base).catch(() => [])
    : [];
  console.log(printStatus(state));`,
  },
];

const groups = new Map();
for (const fix of FIXES) {
  if (!groups.has(fix.file)) groups.set(fix.file, []);
  groups.get(fix.file).push(fix);
}

let totalApplied = 0;
let totalSkipped = 0;
const failed = [];

for (const [rel, fixes] of groups) {
  const fp = path.join(PKG, rel);
  if (!fs.existsSync(fp)) {
    for (const f of fixes) failed.push({ ...f, reason: "文件不存在" });
    continue;
  }
  const before = fs.readFileSync(fp, "utf8");
  let text = before;
  const applied = [];
  const skipped = [];
  for (const fix of fixes) {
    if (text.includes(fix.marker)) { skipped.push(fix); continue; }
    if (!text.includes(fix.from)) { failed.push({ ...fix, reason: "上游文本已变" }); continue; }
    text = text.replace(fix.from, fix.to);
    applied.push(fix);
  }
  console.log(`\n${rel}：应用 ${applied.length} · 已存在 ${skipped.length}`);
  for (const f of applied) console.log(`  + ${f.id} ${f.name}`);
  for (const f of skipped) console.log(`  = ${f.id} 已存在`);
  totalApplied += applied.length;
  totalSkipped += skipped.length;
  if (!dry && text !== before) {
    if (!fs.existsSync(`${fp}.scrub-fix.bak`)) fs.writeFileSync(`${fp}.scrub-fix.bak`, before, "utf8");
    const tmp = `${fp}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, "utf8");
    fs.renameSync(tmp, fp);
  }
}

for (const f of failed) console.log(`  ! ${f.id} ${f.name} — ${f.reason}`);
console.log(`\n合计：应用 ${totalApplied} · 已存在 ${totalSkipped} · 未匹配 ${failed.length}${dry ? "（dry-run）" : ""}`);
if (totalApplied && !dry) console.log("重启 dsh 生效。备份：*.scrub-fix.bak");
if (failed.length) process.exitCode = 1;
