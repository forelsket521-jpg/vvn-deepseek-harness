// vvn · 文件级快照（整棵目标树的时间点备份）
//
// 为什么需要：桌面宿主的回滚只依赖 resources/app.asar.bak 一个文件，
// 官方更新覆盖它之后 revert 就失效；而 .dshpurge.bak 在桌面端实测为 0 个。
// 快照把"当前每个目标文件"原样复制到 $DSH_HOME/vvn/snapshots/<ts>-<label>/，
// 配 manifest（相对路径 + sha256 + 字节数），可回到任意一个时间点。
//
// 语义边界：快照记录的是"拍快照那一刻"的磁盘状态。要回到官方原版，
// 仍然只能靠 app.asar.bak —— 快照不是出厂镜像。

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const KEEP = 6;

export function snapshotRoot(dshHome) {
  return path.join(dshHome, "vvn", "snapshots");
}

function sha256File(fp) {
  return createHash("sha256").update(fs.readFileSync(fp)).digest("hex");
}

function relKey(fp) {
  // 用盘符+去重后的相对路径做 key：不同安装位（resources / profile）不会撞名。
  const norm = path.normalize(fp);
  return norm.replace(/^([A-Za-z]):\\/, "$1/$").replace(/\\/g, "/");
}

/**
 * 拍一份快照。
 * @param {object} opts
 * @param {string[]} opts.targets 需要备份的绝对路径列表
 * @param {string} opts.dshHome
 * @param {string} [opts.label] 快照标签（pre-apply / manual / …）
 * @param {number} [opts.keep] 保留份数
 */
export function createSnapshot({ targets, dshHome, label = "manual", keep = KEEP } = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const id = `${stamp}-${label}`;
  const dir = path.join(snapshotRoot(dshHome), id);
  const filesDir = path.join(dir, "files");
  fs.mkdirSync(filesDir, { recursive: true });

  const entries = [];
  const errors = [];
  for (const fp of targets || []) {
    try {
      if (!fs.existsSync(fp)) continue;
      const stat = fs.statSync(fp);
      if (!stat.isFile()) continue;
      const rel = relKey(fp);
      const dst = path.join(filesDir, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(fp, dst);
      entries.push({ path: fp, rel, bytes: stat.size, sha256: sha256File(fp) });
    } catch (e) {
      errors.push({ path: fp, error: String(e && e.message ? e.message : e) });
    }
  }

  const manifest = {
    id,
    label,
    at: new Date().toISOString(),
    files: entries.length,
    bytes: entries.reduce((n, x) => n + x.bytes, 0),
    entries,
    errors,
  };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  pruneSnapshots(dshHome, keep);
  return manifest;
}

export function listSnapshots(dshHome) {
  const root = snapshotRoot(dshHome);
  let names = [];
  try {
    names = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names.sort().reverse()) {
    const fp = path.join(root, name, "manifest.json");
    try {
      const m = JSON.parse(fs.readFileSync(fp, "utf8"));
      out.push({ id: m.id || name, at: m.at, label: m.label, files: m.files, bytes: m.bytes });
    } catch {
      out.push({ id: name, at: "", label: "?", files: 0, bytes: 0, broken: true });
    }
  }
  return out;
}

function pruneSnapshots(dshHome, keep) {
  const list = listSnapshots(dshHome);
  for (const s of list.slice(keep)) {
    try {
      fs.rmSync(path.join(snapshotRoot(dshHome), s.id), { recursive: true, force: true });
    } catch {
      /* 删不掉就留着，不影响主流程 */
    }
  }
}

/**
 * 从快照还原。默认校验 sha256，不一致的跳过（除非 force）。
 * @returns {{id:string, restored:string[], skipped:Array, missing:string[]}}
 */
export function restoreSnapshot({ dshHome, id, force = false, only = [] } = {}) {
  const dir = path.join(snapshotRoot(dshHome), id);
  const manifestPath = path.join(dir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const want = only.length ? new Set(only) : null;
  const restored = [];
  const skipped = [];
  const missing = [];

  for (const entry of manifest.entries || []) {
    if (want && !want.has(entry.path)) continue;
    const src = path.join(dir, "files", entry.rel);
    if (!fs.existsSync(src)) {
      missing.push(entry.path);
      continue;
    }
    if (!force) {
      const got = sha256File(src);
      if (entry.sha256 && got !== entry.sha256) {
        skipped.push({ path: entry.path, reason: "sha256 不一致（快照文件被改过）" });
        continue;
      }
    }
    try {
      fs.mkdirSync(path.dirname(entry.path), { recursive: true });
      const tmp = `${entry.path}.${process.pid}.${Date.now()}.snaptmp`;
      fs.copyFileSync(src, tmp);
      fs.renameSync(tmp, entry.path);
      restored.push(entry.path);
    } catch (e) {
      skipped.push({ path: entry.path, reason: String(e && e.message ? e.message : e) });
    }
  }
  return { id, restored, skipped, missing };
}
