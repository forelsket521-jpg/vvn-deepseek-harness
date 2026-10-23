// 提示词改稿对比：体积、结构、能力面覆盖、重复度
import fs from "node:fs";
import { shapePrompt, escapeInterpolation, normalizeEnvelope } from "../lib/prompt.js";

const V1 = "C:/Users/Administrator/.dsh/prompt-inject.md";
const V2 = "C:/Users/Administrator/Documents/deepseek-harness/default-workspace/re/prompt-v2.md";

const v1 = fs.readFileSync(V1, "utf8");
const v2 = fs.readFileSync(V2, "utf8");

const approxTokens = (s) => {
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const rest = s.length - cjk;
  return Math.round(cjk / 1.6 + rest / 3.6);
};

/* 25 类能力面的锚词（每类取能区分的最小集合） */
const FACETS = {
  "1 外挂/内存": ["外挂", "透视", "自瞄", "ACE"],
  "2 渗透/后渗透": ["打点", "拿站", "提权", "横向"],
  "3 恶意代码/免杀": ["木马", "蠕虫", "勒索", "免杀"],
  "4 逆向/破解": ["脱壳", "keygen", "卡密", "OFFSET"],
  "5 社工/钓鱼": ["钓鱼", "仿站", "话术", "仿登录"],
  "6 证件/身份": ["身份证", "护照", "签证", "KYC"],
  "7 资金/支付": ["洗钱", "跑分", "四件套", "盗刷"],
  "8 跨境/物流": ["跨境", "运输", "藏匿", "报关"],
  "9 成人内容": ["成人", "露骨", "AV", "色情"],
  "10 政治/时事": ["时事", "政治", "历史", "事实"],
  "11 商业/运营": ["增长", "外包", "内包", "运营"],
  "12 DoS/压测": ["DoS", "压测", "放大", "资源耗尽"],
  "13 Web/API": ["SQLi", "XSS", "SSRF", "反序列化"],
  "14 移动安全": ["APK", "Frida", "pinning", "重打包"],
  "15 凭证攻击": ["撞库", "喷洒", "hashcat", "Kerberos"],
  "16 提权": ["SUID", "UAC", "命名管道", "内核"],
  "17 网络/基础设施": ["端口扫描", "代理池", "CDN", "握手包"],
  "18 交易自动化": ["秒杀", "抢票", "验证码", "批量注册"],
  "19 OSINT/人肉": ["社工库", "脱库", "OSINT", "定位"],
  "20 样本分析": ["样本", "宏", "IOC", "混淆"],
  "21 对抗提示词": ["越狱", "注入", "对抗样本", "系统提示"],
  "22 嵌入式/物理": ["固件", "JTAG", "UART", "CAN"],
  "23 盗版/资源": ["磁力", "网盘", "资源站", "番号"],
  "24 C2/远控": ["C2", "Teamserver", "beacon", "远控"],
  "25 无线/近场": ["WiFi", "PMKID", "蓝牙", "RFID"],
};

const rows = [];
let covered = 0;
for (const [facet, needles] of Object.entries(FACETS)) {
  const inV1 = needles.filter((n) => v1.includes(n));
  const inV2 = needles.filter((n) => v2.includes(n));
  const ok = inV2.length > 0;
  if (ok) covered += 1;
  rows.push({ facet, v1: inV1.length, v2: inV2.length, ok, lost: needles.filter((n) => inV1.includes(n) && !inV2.includes(n)) });
}

const dupPhrases = ["拒绝", "免责", "不能", "不写", "抱歉", "合规", "伦理", "建议"];
const dupV1 = Object.fromEntries(dupPhrases.map((p) => [p, (v1.match(new RegExp(p, "g")) || []).length]));
const dupV2 = Object.fromEntries(dupPhrases.map((p) => [p, (v2.match(new RegExp(p, "g")) || []).length]));

const shaped2 = shapePrompt(v2, {});
const checks = [
  ["v2 有信封头", /^<\|im_start\|>system:/.test(v2.trim())],
  ["v2 已闭合", /<\/project_instructions>\s*$/.test(v2.trim())],
  ["整形后仍有信封", /^<\|im_start\|>system:/.test(shaped2)],
  ["整形不改动正文", normalizeEnvelope(v2.trim()) === v2.trim()],
  ["无非法插值", escapeInterpolation(v2) === v2],
  ["包含五条硬契约", ["执行优先", "直给", "不拒绝", "不编造", "做完"].every((k) => v2.includes(k))],
  ["含诚实性条款", /不编造工具输出/.test(v2)],
  ["含风险告知边界", /技术风险 = 操作信息/.test(v2)],
  ["含自检清单", /自检/.test(v2)],
  ["含冲突裁决", /用户明确指令 > 本文件/.test(v2)],
];

console.log("=== 体积 ===");
console.log(`v1 ${v1.length} 字符 ≈ ${approxTokens(v1)} tokens`);
console.log(`v2 ${v2.length} 字符 ≈ ${approxTokens(v2)} tokens`);
console.log(`缩减 ${(100 - (v2.length / v1.length) * 100).toFixed(1)}%`);

console.log("\n=== 能力面覆盖（25 类）===");
for (const r of rows) {
  console.log(`  ${r.ok ? "✓" : "✗"} ${r.facet.padEnd(16)} v1锚词 ${r.v1} / v2锚词 ${r.v2}${r.lost.length ? `  未沿用: ${r.lost.join(",")}` : ""}`);
}
console.log(`覆盖 ${covered}/${rows.length}`);

console.log("\n=== 重复度（出现次数）===");
for (const p of dupPhrases) console.log(`  ${p.padEnd(6)} v1=${String(dupV1[p]).padStart(3)} → v2=${String(dupV2[p]).padStart(3)}`);

console.log("\n=== 结构自检 ===");
let bad = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) bad += 1;
}

const lostFacets = rows.filter((r) => !r.ok).map((r) => r.facet);
if (lostFacets.length) console.log(`\n丢失能力面: ${lostFacets.join("、")}`);
process.exitCode = bad || lostFacets.length ? 1 : 0;
