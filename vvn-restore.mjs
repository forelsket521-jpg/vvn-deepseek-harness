// vvn 的快照工具：列快照 / 还原快照。
//
// 为什么单独做成脚本，而不是在 C# 里拼一段 JS 传 -e：
//   1. 拼字符串要手工转义引号，路径里有空格或引号就碎；
//   2. 逻辑改一次要改两处（C# 一处、shell 一处）；
//   3. 这样能单独测，也能让 C# 那边只处理"参数进、JSON 出"。
//
// 用法：
//   node restore.mjs list   <snapshot.js 路径>
//   node restore.mjs restore <snapshot.js 路径> <快照ID> [--dry]
//
// 输出：一行 JSON（C# 用标准 JSON 解析器读，不再手撸）。

import fs from "node:fs";
import path from "node:path";

const DSH_HOME = process.env.USERPROFILE ? path.join(process.env.USERPROFILE, ".dsh") : "";
const SNAP_ROOT = path.join(DSH_HOME, "dsh-purge", "snapshots");

function out(obj) {
  process.stdout.write(JSON.stringify(obj));
}

/** 不依赖 snapshot.js 也能列 —— 直接读 manifest，少一层依赖。 */
function listSnapshots() {
  let names = [];
  try {
    names = fs.readdirSync(SNAP_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const list = [];
  for (const name of names.sort().reverse()) {
    const mf = path.join(SNAP_ROOT, name, "manifest.json");
    try {
      const m = JSON.parse(fs.readFileSync(mf, "utf8"));
      list.push({
        id: String(m.id || name),
        label: String(m.label || ""),
        at: String(m.at || ""),
        files: Number(m.files || 0),
        bytes: Number(m.bytes || 0),
      });
    } catch (e) {
      list.push({ id: name, label: "?", at: "", files: 0, bytes: 0, broken: String(e.message) });
    }
  }
  return list;
}

async function main() {
  const [cmd, snapJs, id, flag] = process.argv.slice(2);

  if (cmd === "list") {
    out({ ok: true, snapshots: listSnapshots() });
    return;
  }

  if (cmd === "restore") {
    const dry = flag === "--dry";
    const known = listSnapshots().map((s) => s.id);
    if (!id || !known.includes(id)) {
      out({ ok: false, error: "unknown snapshot id", id: id || "", known });
      process.exit(3);
    }
    if (dry) {
      out({ ok: true, dry: true, id });
      return;
    }
    if (!snapJs || !fs.existsSync(snapJs)) {
      out({ ok: false, error: "snapshot module not found: " + snapJs });
      process.exit(4);
    }
    const mod = await import("file:///" + snapJs.replace(/\\/g, "/"));
    const r = mod.restoreSnapshot({ dshHome: DSH_HOME, id });
    out({ ok: true, id, restored: r.restored, skipped: r.skipped, missing: r.missing });
    return;
  }

  out({ ok: false, error: "usage: list | restore <snap.js> <id> [--dry]" });
  process.exit(2);
}

main().catch((e) => {
  out({ ok: false, error: String(e && e.message ? e.message : e) });
  process.exit(1);
});