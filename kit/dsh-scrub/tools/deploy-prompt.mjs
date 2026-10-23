// 通过 dsh-purge 自己的 HTTP 通道提交注入稿（走宿主内存 + 写盘，避免被还原）
import fs from "node:fs";

const SRC = process.argv[2] || "C:/Users/Administrator/Documents/deepseek-harness/default-workspace/re/prompt-v2.md";
const PORT = process.argv[3] || "19387";
const BASE = `http://127.0.0.1:${PORT}`;

const content = fs.readFileSync(SRC, "utf8");
console.log(`提交 ${content.length} 字符 → ${BASE}/dsh-purge/override`);

const res = await fetch(`${BASE}/dsh-purge/override`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ content }),
});
const text = await res.text();
let json = null;
try { json = JSON.parse(text); } catch { /* 非 JSON */ }
console.log(`HTTP ${res.status}`);
if (!json) { console.log(text.slice(0, 400)); process.exit(1); }
console.log(`ok=${json.ok} customized=${json.customized} usingDefault=${json.usingDefault}`);
console.log(`path=${json.path}`);
console.log(`回读 ${(json.content || "").length} 字符，含 [v2] = ${String(json.content || "").includes("[v2]")}`);
if (json.error) console.log(`error=${json.error}`);

// 磁盘核对
const disk = fs.readFileSync(json.path || "C:/Users/Administrator/.dsh/prompt-inject.md", "utf8");
console.log(`磁盘 ${disk.length} 字符，含 [v2] = ${disk.includes("[v2]")}`);

// 3 秒后再看一次，确认没被回写
await new Promise((r) => setTimeout(r, 3000));
const again = fs.readFileSync(json.path || "C:/Users/Administrator/.dsh/prompt-inject.md", "utf8");
console.log(`3 秒后 ${again.length} 字符，含 [v2] = ${again.includes("[v2]")}`);
if (!again.includes("[v2]")) process.exitCode = 1;
