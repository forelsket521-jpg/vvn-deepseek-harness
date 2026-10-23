// 把旧版插件（dsh-purge）留下的数据搬到新版（vvn）的目录下。
//
// 为什么需要这个：
//   插件把状态存在 ~/.dsh/<包名>/ 下，里面包括
//     · snapshots/          每次清洗前的文件备份（最重要，没了就不能还原）
//     · apply-state.json    上次清洗到哪一步
//     · hooks-deny.json     宿主规则托管状态
//     · drill-grant.json    权限授权记录
//   包名一改，插件就会去找新目录，找不到就以为"什么都没做过" ——
//   实测直接表现为补丁计数从 78/82 掉到 28/82，而且快照全丢。
//
// 策略：
//   · 只在"新目录不存在或基本是空的"时候搬
//   · 快照目录按份合并，同名的跳过（不覆盖已有的）
//   · 小状态文件只在新的不存在时才拷
//   · 搬完写一个标记，避免每次启动都检查
import fs from "node:fs";
import path from "node:path";

const OLD_NAME = "dsh-purge";   // 改名前的包名
const NEW_NAME = "vvn";         // 改名后的包名

/** 需要搬的小文件（整份拷）。快照目录单独处理。 */
const SMALL_FILES = [
  "apply-state.json",
  "hooks-deny.json",
  "drill-grant.json",
  "override-state.json",
  "installed-rev",
  "unpacked-asar.json",
  "last-cwd.txt",
  "net-allow.json",
];

function exists(p) {
  try { fs.statSync(p); return true; } catch { return false; }
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

/**
 * @param {string} dshHome  ~/.dsh
 * @param {{ log?: (s: string) => void }} [opts]
 * @returns {{ migrated: boolean, files: number, snapshots: number, reason?: string }}
 */
export function migrateLegacyData(dshHome, opts = {}) {
  const log = opts.log || (() => {});
  const result = { migrated: false, files: 0, snapshots: 0 };

  if (!dshHome) return { ...result, reason: "no dshHome" };

  const oldDir = path.join(dshHome, OLD_NAME);
  const newDir = path.join(dshHome, NEW_NAME);

  if (!exists(oldDir)) return { ...result, reason: "no legacy dir" };
  if (path.resolve(oldDir) === path.resolve(newDir)) return { ...result, reason: "same dir" };

  // 新目录已经用过（有 apply-state 或快照），就不要乱动
  const newState = path.join(newDir, "apply-state.json");
  const newSnaps = path.join(newDir, "snapshots");
  const newSnapCount = exists(newSnaps) ? fs.readdirSync(newSnaps).length : 0;
  if (exists(newState) && newSnapCount > 0) {
    return { ...result, reason: "new dir already in use" };
  }

  try { fs.mkdirSync(newDir, { recursive: true }); } catch (e) {
    return { ...result, reason: "mkdir failed: " + e.message };
  }

  // 1) 小文件：新的不存在才拷
  for (const name of SMALL_FILES) {
    const from = path.join(oldDir, name);
    const to = path.join(newDir, name);
    if (!exists(from) || exists(to)) continue;
    try {
      fs.copyFileSync(from, to);
      result.files++;
      log("迁入 " + name);
    } catch (e) {
      log("跳过 " + name + "（" + e.message + "）");
    }
  }

  // 2) 快照：按份合并。旧的可能比新的多，必须一份份来。
  const oldSnaps = path.join(oldDir, "snapshots");
  if (exists(oldSnaps)) {
    try { fs.mkdirSync(newSnaps, { recursive: true }); } catch { /* 已经在了 */ }
    let names = [];
    try { names = fs.readdirSync(oldSnaps); } catch { names = []; }
    for (const n of names) {
      const from = path.join(oldSnaps, n);
      const to = path.join(newSnaps, n);
      if (exists(to)) continue;      // 同名的留着新的，不覆盖
      try {
        fs.cpSync(from, to, { recursive: true });
        result.snapshots++;
      } catch (e) {
        log("快照 " + n + " 迁移失败：" + e.message);
      }
    }
    if (result.snapshots > 0) log("迁入 " + result.snapshots + " 份快照");
  }

  // 3) 留个记录，方便排查
  try {
    fs.writeFileSync(path.join(newDir, "migrated-from.json"), JSON.stringify({
      from: OLD_NAME,
      at: new Date().toISOString(),
      files: result.files,
      snapshots: result.snapshots,
    }, null, 2), "utf8");
  } catch { /* 无关紧要 */ }

  result.migrated = result.files > 0 || result.snapshots > 0;
  if (!result.migrated) result.reason = "nothing to migrate";
  return result;
}

/** 旧目录还在不在（给界面显示用） */
export function hasLegacyData(dshHome) {
  if (!dshHome) return false;
  return exists(path.join(dshHome, OLD_NAME));
}

/** 旧目录里有没有东西 */
export function legacySummary(dshHome) {
  const oldDir = path.join(dshHome || "", OLD_NAME);
  if (!exists(oldDir)) return null;
  const snaps = path.join(oldDir, "snapshots");
  return {
    dir: oldDir,
    snapshots: exists(snaps) ? fs.readdirSync(snaps).length : 0,
    state: readJsonSafe(path.join(oldDir, "apply-state.json")),
  };
}