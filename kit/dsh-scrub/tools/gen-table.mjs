// 从 dsh-purge 的 ALL_PATCHES 生成 dsh-scrub 自用的静态补丁表。
// 只取「数据」不要它的引擎：dsh-scrub 的执行器是自己写的。
import fs from "node:fs";

const SRC = "C:/Users/Administrator/.dsh/profiles/desktop/node_modules/dsh-purge";
const OUT = "C:/Users/Administrator/Documents/deepseek-harness/default-workspace/dsh-scrub/lib/table.data.js";

const core = await import("file://" + SRC + "/lib/core.js");

const FIELDS = [
  "id", "name", "layer", "layer_en", "desc", "file", "rel", "surfaces",
  "optional", "skipIfMarked", "markersAny", "markers", "marker", "forbid",
  "softSettle", "strictFiles",
];

function isRegExp(v) {
  return Object.prototype.toString.call(v) === "[object RegExp]";
}

function encodePattern(pat) {
  if (isRegExp(pat)) return { re: pat.source, flags: pat.flags };
  return String(pat ?? "");
}

function encodePatch(p) {
  const out = {};
  for (const f of FIELDS) if (p[f] !== undefined) out[f] = p[f];
  if (Array.isArray(p.patterns) && !Array.isArray(p.replacements)) {
    out.replacements = p.patterns.map((pat) => ({ pattern: encodePattern(pat), replace: String(p.replace ?? "") }));
  } else {
    out.replacements = (p.replacements || []).map((r) => ({
      pattern: encodePattern(r.pattern),
      replace: String(r.replace ?? ""),
    }));
  }
  return out;
}

const table = core.ALL_PATCHES.map(encodePatch);

const head = `// dsh-scrub · 补丁数据表（自动生成，勿手改）
// 生成器：tools/gen-table.mjs  来源：dsh-purge@${JSON.parse(fs.readFileSync(SRC + "/package.json", "utf8")).version} 的 ALL_PATCHES
// 只含数据（needle / replacement / marker / 目标资产），不含任何执行逻辑。
// 每条补丁的 replacements[].pattern 要么是字符串 needle，要么是 { re, flags }（自匹配型正则）。

`;

const body = `export const TABLE = ${JSON.stringify(table, null, 0)};
`;

fs.writeFileSync(OUT, head + body, "utf8");

const stats = {
  patches: table.length,
  needles: table.reduce((n, p) => n + p.replacements.length, 0),
  regexNeedles: table.reduce((n, p) => n + p.replacements.filter((r) => typeof r.pattern === "object").length, 0),
  bytes: (head + body).length,
  layers: table.reduce((a, p) => ((a[p.layer] = (a[p.layer] || 0) + 1), a), {}),
};
console.log(JSON.stringify(stats, null, 1));
