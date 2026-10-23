// 把默认注入稿封进 lib/prompt.sealed.js（dsh-scrub 自己的密文格式）
import fs from "node:fs";
import path from "node:path";
import { sealText, openSealed, describe } from "../lib/vault.js";

const SRC_PLAIN = process.argv[2] || "C:/Users/Administrator/Documents/deepseek-harness/default-workspace/re/dsh-purge/asset-table.txt";
const OUT = "C:/Users/Administrator/Documents/deepseek-harness/default-workspace/dsh-scrub/lib/prompt.sealed.js";

const plain = fs.readFileSync(SRC_PLAIN, "utf8").replace(/\r\n/g, "\n").trim();
const blob = sealText(plain);

// 往返自检：解不出原文就不落盘
const back = openSealed(blob);
if (back !== plain) {
  console.error("roundtrip failed");
  process.exit(1);
}

const file = `// dsh-scrub · 默认注入稿（密文，勿手改）
// 生成器：tools/seal-prompt.mjs   算法：${blob.alg} + brotli + xor(0x${Number(blob.mask).toString(16)})    KDF：${blob.kdf}
// 明文 sha256：${blob.sha256}
// 明文 ${plain.length} 字符 → 密文 ${Buffer.from(blob.body, "base64").length} 字节

export const SEALED_PROMPT = ${JSON.stringify(blob, null, 2)};
`;

fs.writeFileSync(OUT, `${file}`, "utf8");
console.log("sealed:", describe(blob));
console.log("plain chars:", plain.length, "| sealed file bytes:", file.length);
