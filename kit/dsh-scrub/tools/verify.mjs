// 等价性验证：dsh-scrub 的定位层与状态机 vs dsh-purge 的实测快照
import fs from "node:fs";
import { findAiBases, pickAiBase, targetFiles, pathsOf } from "../lib/locate.js";
import { survey, tally, allPatches } from "../lib/engine.js";

const REF_DIR = "C:/Users/Administrator/Documents/deepseek-harness/default-workspace/re/dsh-purge";
const ref = JSON.parse(fs.readFileSync(REF_DIR + "/analysis.json", "utf8"));
const refStatus = new Map(ref.rows.map((r) => [r.id, r.status]));
const refPaths = new Map();
for (const r of ref.rows) {
  for (const f of r.files || []) {
    if (!refPaths.has(f.key)) refPaths.set(f.key, []);
    const p = f.fp.replace(/\\/g, "/");
    if (!refPaths.get(f.key).includes(p)) refPaths.get(f.key).push(p);
  }
}

const aiBases = findAiBases({ dshHome: "C:/Users/Administrator/.dsh" });
console.log("aiBases:", aiBases);
const aiBase = pickAiBase({ aiBase: "C:\\deepseek\\resources\\app\\dsh\\node_modules\\@deepseek-ai" });
const map = targetFiles(aiBase, { dshHome: "C:/Users/Administrator/.dsh" });

// 1) key 覆盖
const tableKeys = new Set(allPatches().flatMap((p) => p.keys));
const missingKeys = [...tableKeys].filter((k) => !(k in map));
console.log("table keys:", tableKeys.size, "| locate keys:", Object.keys(map).length, "| 未覆盖:", missingKeys.length ? missingKeys : "无");

// 2) 路径一致性
let pathMismatch = 0;
for (const [key, want] of refPaths) {
  const got = pathsOf(map, key).map((p) => p.replace(/\\/g, "/"));
  const same = want.length === got.length && want.every((w, i) => w === got[i]);
  if (!same) {
    pathMismatch += 1;
    console.log(`  ✗ ${key}\n     ref=${JSON.stringify(want)}\n     got=${JSON.stringify(got)}`);
  }
}
console.log("路径不一致 key 数:", pathMismatch);

// 3) 状态一致性
const rows = await survey({ aiBase, dshHome: "C:/Users/Administrator/.dsh", surface: "desktop" });
console.log("tally:", JSON.stringify(tally(rows)));
let statusMismatch = 0;
for (const r of rows) {
  const want = refStatus.get(r.id);
  // dsh-purge 用 missing_file，本实现用 missing
  const norm = (s) => (s === "missing_file" ? "missing" : s);
  if (norm(want) !== norm(r.status)) {
    statusMismatch += 1;
    console.log(`  ✗ #${r.id} ${r.name}: ref=${want} got=${r.status}`);
  }
}
console.log("状态不一致条数:", statusMismatch);
