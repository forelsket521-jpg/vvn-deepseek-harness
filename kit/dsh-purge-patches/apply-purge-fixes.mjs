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
    marker: "const isPartial = !patchApplied(text, p)",
    from: `        const appliedText = applyReplacementsToText(text, p, fp);
        let textOut = appliedText.text;`,
    to: `        {
          const stat = needleHitStats(text, p, fp);
          // 只有"还没打过、且多条 needle 只命中一部分"才拦：
          // 打下去必然半写。已经 applied 的（half_write）拦也没用，归诊断报告。
          const isPartial = !patchApplied(text, p) && stat.hit > 0 && stat.hit < stat.total;
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
    marker: "⚠ 半写（marker 已落",
    from: `  if (Array.isArray(state.partial) && state.partial.length) {
    out.push("");
    out.push("  ⚠ 部分命中（needle 需按当前宿主版本更新；严格模式 blockPartial 会拒写）:");
    for (const x of state.partial) {
      out.push(\`    [#\${String(x.id).padEnd(2)}] \${x.name.padEnd(36)} \${x.hit}/\${x.total}  \${x.path}\`);
    }
  }`,
    to: `  if (Array.isArray(state.partial) && state.partial.length) {
    const half = state.partial.filter((x) => x.type === "half_write");
    const stale = state.partial.filter((x) => x.type === "stale_needle");
    out.push("");
    if (half.length) {
      out.push("  ⚠ 半写（marker 已落、仍留有旧文本，状态页却显示 applied）:");
      for (const x of half) out.push(\`    [#\${String(x.id).padEnd(2)}] \${x.name.padEnd(36)} \${x.hit}/\${x.total} 缺组 \${x.missing_groups}/\${x.groups}\`);
    }
    if (stale.length) {
      out.push("  ⚠ needle 漂移（还没打，只命中一部分；blockPartial 会拒写）:");
      for (const x of stale) out.push(\`    [#\${String(x.id).padEnd(2)}] \${x.name.padEnd(36)} \${x.hit}/\${x.total} 缺组 \${x.missing_groups}/\${x.groups}\`);
    }
  }`,
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
{
    id: "FIX-9", file: CORE, name: "isTextShim 改用 readFileSync（hostFs 没有 readSync）",
    marker: "这里必须用 readFileSync 而不是 openSync+readSync",
    from: `function isTextShim(fp) {
  // H18:只读前 512 字节。readFileSync 整文件把 PATH 上几 MB 的 exe 全载进来会 OOM 并拖慢扫描。
  let fd;
  try {
    fd = fs.openSync(fp, "r");
    const buf = Buffer.allocUnsafe(512);
    const n = fs.readSync(fd, buf, 0, 512, 0);
    const slice = buf.subarray(0, n);
    if (slice.includes(0)) return false;
    const head = slice.subarray(0, Math.min(120, n)).toString("utf8");
    return head.startsWith("#!") || /@echo/i.test(head) || head.startsWith("REM ") || head.startsWith("# ");
  } catch {
    return false;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}`,
    to: `export function isTextShim(fp) {
  // 只读前 512 字节判定，避免把 PATH 上几 MB 的 exe 整个载进来。
  //
  // 这里必须用 readFileSync 而不是 openSync+readSync：
  // \`fs\` 是 hostFs（extract-asar.js 的路径代理），它的 HOST_SYNC 白名单里
  // 没有 readSync / closeSync。用后者会抛 "fs.readSync is not a function"，
  // 被下面的 catch 吞掉，于是**所有 shim 都被误判成 binary**。
  try {
    const st = fs.statSync(fp);
    if (!st.isFile()) return false;
    const buf = fs.readFileSync(fp);
    const slice = buf.subarray(0, 512);
    if (slice.includes(0)) return false;
    const head = slice.subarray(0, Math.min(120, slice.length)).toString("utf8");
    return head.startsWith("#!") || /@echo/i.test(head) || head.startsWith("REM ") || head.startsWith("# ");
  } catch {
    return false;
  }
}`,
  },
  {
    id: "FIX-10", file: CORE, name: "shim 跳过原因可读化",
    marker: "export function shimSkipReason() {",
    from: `export async function hasBackup(aiBase) {`,
    to: `/**
 * shim 注入为什么要跳过。
 *
 * 桌面端的 \`runtime\\cli\\bin\\dsh.cmd\` 落在密封运行时目录里，属于安装包范围：
 * 注入会被官方更新整体覆盖，也可能碰到程序自校验；而且桌面端启动走的是
 * \`DeepSeek Harness.exe\`，压根不经过 dsh.cmd —— 给它注入 DSH_HOME 没有意义。
 * 所以 listShimDirsForPatch() 在桌面端返回空是设计如此，不是找不到。
 */
export function shimSkipReason() {
  if (adapterFor(detectSurface()) !== "desktop") {
    return findShimDir() ? "" : "no_npm_launcher";
  }
  const dir = findDesktopShimDir();
  if (!dir) return "no_desktop_runtime";
  return "sealed_desktop_runtime";
}

export function shimSkipText(reason) {
  switch (reason) {
    case "sealed_desktop_runtime":
      return "桌面端：dsh.cmd 在密封运行时目录，官方更新会整体覆盖，因此不注入；桌面启动不经过它，无需处理";
    case "no_desktop_runtime":
      return "桌面端：未找到运行时目录，但桌面启动不经过 dsh.cmd，无需处理";
    case "no_npm_launcher":
      return "未找到 npm 全局 bin 里的 dsh 启动器；如果用命令行跑 dsh，装一次全局包即可";
    default:
      return "";
  }
}

export async function hasBackup(aiBase) {`,
  },
  {
    id: "FIX-11", file: CORE, name: "gatherState 暴露 shim 跳过原因",
    marker: "shim_skip_reason: shimSkipReason(),",
    from: `  return {
    alert,
    snapshots,
    surface: detectSurface(),`,
    to: `  return {
    alert,
    snapshots,
    shim_skip_reason: shimSkipReason(),
    surface: detectSurface(),`,
  },
  {
    id: "FIX-12", file: BIN, name: "CLI 说清 shim 为何跳过",
    marker: "shim 跳过注入：",
    from: `    } else {
      console.log("  ⚠ 未定位 shim 目录，跳过注入");
    }`,
    to: `    } else {
      const why = core.shimSkipText ? core.shimSkipText(state.shim_skip_reason) : "";
      console.log(why ? \`  - shim 跳过注入：\${why}\` : "  - shim 跳过注入");
    }`,
  },
  {
    id: "FIX-13", file: BIN, name: "状态页 shim 行标注",
    marker: "桌面端不适用（密封运行时，启动不经过它）",
    from: `  out.push(\`  shim 目录      \${state.shim_dir || "未定位 / not found"}\`);`,
    to: `  out.push(\`  shim 目录      \${state.shim_dir || (state.shim_skip_reason === "sealed_desktop_runtime" ? "桌面端不适用（密封运行时，启动不经过它）" : "未定位 / not found")}\`);`,
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
