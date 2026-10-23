// 把自带插件的包名从 dsh-purge 改成 vvn。
//
// 为什么要写成脚本而不是手工 sed：
// 这个包名不只是"显示名"，它同时是
//   1) package.json 的 name / bin / exports
//   2) 插件识别自己插入的 section 的标记（startsWith("dsh-purge")）
//   3) needle 匹配串（DSH_PURGE_MARKER_NEEDLE）
//   4) 数据目录名（~/.dsh/dsh-purge/）
// 只改其中一部分，插件就认不出自己注入过的内容 —— 表现为重复注入、
// 或者状态显示不对。所以必须整套一次改完。
//
// 用法：
//   node rename-plugin.mjs <插件目录> [--check]
import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2];
const checkOnly = process.argv.includes("--check");
if (!dir || !fs.existsSync(dir)) {
  console.error("用法: node rename-plugin.mjs <插件目录> [--check]");
  process.exit(1);
}

const FROM = "dsh-purge";
const TO = "vvn";

// 注释里的 [dsh-purge] 只是标记哪段是工具加的，改不改都不影响功能。
// 为了统一也一起改 —— 保留原始署名放在 ATTRIBUTION 文件里。
const targets = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      // 跳过体积大又无关的
      if (e.name === "node_modules" || e.name === ".git") continue;
      walk(p);
    } else if (/\.(js|mjs|cjs|json|yml|yaml|md|txt)$/i.test(e.name)) {
      targets.push(p);
    }
  }
})(dir);

const stats = { files: 0, hits: 0 };
const changed = [];

for (const f of targets) {
  let text;
  try { text = fs.readFileSync(f, "utf8"); } catch { continue; }
  if (!text.includes(FROM)) continue;

  const n = text.split(FROM).length - 1;
  stats.files++;
  stats.hits += n;
  changed.push({ file: path.relative(dir, f), hits: n });

  if (!checkOnly) {
    // 全部替换。包名是整体标识，留一半会坏。
    fs.writeFileSync(f, text.split(FROM).join(TO), "utf8");
  }
}

// 目录名（bin/dsh-purge.js → bin/vvn.js）
const binOld = path.join(dir, "bin", "dsh-purge.js");
const binNew = path.join(dir, "bin", "vvn.js");
if (fs.existsSync(binOld)) {
  changed.push({ file: "RENAME bin/dsh-purge.js → bin/vvn.js", hits: 1 });
  if (!checkOnly) fs.renameSync(binOld, binNew);
}

console.log(checkOnly ? "=== 预演（未改动）===" : "=== 已改名 ===");
console.log("涉及文件:", stats.files, " 替换处:", stats.hits);
console.log("");
for (const c of changed.sort((a, b) => b.hits - a.hits)) {
  console.log("  " + String(c.hits).padStart(4) + "x  " + c.file);
}
if (!checkOnly) console.log("\n完成。包名 " + FROM + " → " + TO);