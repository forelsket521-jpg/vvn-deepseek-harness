// 端到端自测：全部在临时目录里跑，不碰真实宿主。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyPatches, survey, revertPatches, tally, bakPath, allPatches, patchById } from "../lib/engine.js";
import { shapePrompt, defaultPrompt, escapeInterpolation, clipStrictBlock, clipCtfContract, capsText } from "../lib/prompt.js";
import { sealText, openSealed } from "../lib/vault.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scrub-test-"));
const home = path.join(tmp, "home");
fs.mkdirSync(home, { recursive: true });

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok, extra });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? "  " + extra : ""}`);
};

/* ── 1. vault 往返 ─────────────────────────────────────── */
const blob = sealText("hello scrub");
check("vault roundtrip", openSealed(blob) === "hello scrub");
check("vault rejects tamper", openSealed({ ...blob, tag: Buffer.alloc(16).toString("base64") }) === "");

/* ── 2. 提示词整形 ─────────────────────────────────────── */
const plain = defaultPrompt();
check("默认稿可解封", plain.length > 20000, `${plain.length} chars`);
const shaped = shapePrompt(plain, {});
check("信封规范化", shaped.startsWith("<|im_start|>system:") && /<\/project_instructions>\s*$/.test(shaped));
check("插值转义", escapeInterpolation("a {{foo}} b {{cwd}}").includes("{ {foo}}") && escapeInterpolation("{{cwd}}") === "{{cwd}}");
check("极简剪裁去掉 STRICT", !clipStrictBlock("x\nSTRICT REQUIREMENT — MUST USE\n- a\n═══════════════════════════════════════\nkeep").includes("MUST USE"));
check("红队剪裁去掉 CTF", !clipCtfContract("head\n═══════════════════════════════════════\nCTF Core Contract\ntext\n═══════════════════════════════════════\ntail").includes("CTF Core Contract"));
check("能力协议三态", capsText({ role: "main" }).includes("能力选用") && capsText({ role: "redteam" }).includes("主控") && capsText({ role: "redteam-child" }).includes("执行者"));

/* ── 3. 夹具：用补丁自己的 needle 造原始文件 ──────────── */
const aiBase = path.join(tmp, "ai", "@deepseek-ai");
const fixtures = allPatches()
  .filter((p) => p.needles.length === 1
    && typeof p.needles[0].pattern === "string"
    && p.needles[0].pattern.length > 12
    && !p.keys.some((k) => k.endsWith(".yml")))
  .slice(0, 3);
check("找到单 needle 夹具补丁", fixtures.length === 3, fixtures.map((p) => `#${p.id}`).join(" "));

const filesMap = {};
for (const [i, p] of fixtures.entries()) {
  const key = p.keys[0];
  const dst = path.join(aiBase, `fixture-${i}`, `${key}.js`);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, `// fixture for #${p.id}\n${p.needles[0].pattern}\n// tail\n`, "utf8");
  filesMap[key] = dst;
}
const relevantIds = new Set(fixtures.map((p) => p.id));
const before = Object.fromEntries(Object.entries(filesMap).map(([k, fp]) => [k, fs.readFileSync(fp, "utf8")]));

/* ── 4. survey → dry → apply → survey → revert ─────────── */
const s0 = await survey({ aiBase, dshHome: home, surface: "web", files: filesMap });
const pending0 = s0.filter((r) => relevantIds.has(r.id) && r.status === "pending").length;
check("初始全部 pending", pending0 === fixtures.length, `pending=${pending0}/${fixtures.length}`);

const dry = await applyPatches({ aiBase, dshHome: home, surface: "web", files: filesMap, ids: [...relevantIds], dryRun: true });
check("dry-run 不落盘",
  dry.written.length === 0 && Object.entries(filesMap).every(([k, fp]) => fs.readFileSync(fp, "utf8") === before[k]),
  `would-write=${dry.rows.filter((r) => r.action === "would-write").length}`);

const real = await applyPatches({ aiBase, dshHome: home, surface: "web", files: filesMap, ids: [...relevantIds], dryRun: false });
check("apply 真落盘", real.written.length === 0 ? false : true, `written=${real.written.length} failed=${real.failed.length}`);
check("生成 .scrbak", Object.values(filesMap).every((fp) => fs.existsSync(bakPath(fp))));
check("manifest 落盘", fs.existsSync(path.join(home, "dsh-scrub", "manifest.jsonl")));

const s1 = await survey({ aiBase, dshHome: home, surface: "web", files: filesMap });
const relRows = s1.filter((r) => relevantIds.has(r.id));
check("survey 反映已打", relRows.every((r) => r.status === "applied"), relRows.map((r) => `#${r.id}=${r.status}`).join(" "));

const rev = await revertPatches({ aiBase, dshHome: home, files: filesMap, ids: [...relevantIds] });
check("revert 还原", rev.restored.length > 0, `restored=${rev.restored.length}`);
check("字节级还原一致", Object.entries(filesMap).every(([k, fp]) => fs.readFileSync(fp, "utf8") === before[k]));

/* ── 5. 单条补丁元数据 ─────────────────────────────────── */
const p57 = patchById(57);
check("patchById(57)", Boolean(p57) && p57.name === "DEEPSEEK_SYSTEM_ROLE" && p57.needles.length === 6);

/* ── 汇总 ─────────────────────────────────────────────── */
fs.rmSync(tmp, { recursive: true, force: true });
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} passed${bad.length ? " · failed: " + bad.map((b) => b.name).join(", ") : ""}`);
if (bad.length) process.exitCode = 1;
