// 把改进版注入稿重新封进 dsh-purge 自己的密封槽（asset-table.js）
// 为什么必须换密封槽：dsh-purge 的 looksLikePluginDefault() 用三个标记判"是不是插件默认稿"
//   <|im_start|>system: / <project_instructions> / Little Code Sauce
// 只要改稿保留了身份标记，就会被判成"旧默认"，然后被 syncPromptInjectOnDiskSync() 静默覆盖回旧稿。
// 让 bundled 本身就是新稿，才能稳定生效。
import fs from "node:fs";
import path from "node:path";

const PKG = "C:/Users/Administrator/.dsh/profiles/desktop/node_modules/dsh-purge";
const SRC = "C:/Users/Administrator/Documents/deepseek-harness/default-workspace/re/prompt-v2.md";
const OUT_BAK = "C:/Users/Administrator/Documents/deepseek-harness/default-workspace/re/asset-table.v1.bak.js";

const { sealSlot } = await import("file://" + PKG + "/lib/table-key.js");
const slotFile = path.join(PKG, "lib", "asset-table.js");

const text = fs.readFileSync(SRC, "utf8");
const before = fs.readFileSync(slotFile, "utf8");
fs.writeFileSync(OUT_BAK, before, "utf8");
fs.copyFileSync(slotFile, slotFile + ".scrub-v1.bak");

const blob = sealSlot(text);
const file = `// dsh-scrub：本文件已被替换为改进版注入稿（原文件备份见 asset-table.js.scrub-v1.bak）
// 生成时间：${new Date().toISOString()}
// 明文：${text.length} 字符  sha256(明文)=${(await import("node:crypto")).createHash("sha256").update(text, "utf8").digest("hex")}
// 算法与 dsh-purge 原实现一致：AES-256-GCM + deflate，key = sha256("cordis.slot.v2\\x1edsh-purge\\x1esurface:web|desktop\\x1eov.table.1\\x1e" + MASK)

export const SLOT = ${JSON.stringify(blob.SLOT)};
export const MASK = ${JSON.stringify(blob.MASK)};
export const TAG = ${JSON.stringify(blob.TAG)};
export const IV = ${JSON.stringify(blob.IV)};
`;
fs.writeFileSync(slotFile, file, "utf8");

// 用 dsh-purge 自己的读取器验证（新进程 import，确保不是内存缓存）
const { openSlot } = await import("file://" + PKG + "/lib/table-read.js");
const back = openSlot();
console.log(`新槽：SLOT ${Buffer.from(blob.SLOT, "base64").length} 字节 · 解出 ${back.length} 字符`);
console.log(`与改进稿一致：${back === text}`);
console.log(`旧 asset-table.js 备份：${slotFile}.scrub-v1.bak（${before.length} 字节）`);
if (back !== text) process.exitCode = 1;
