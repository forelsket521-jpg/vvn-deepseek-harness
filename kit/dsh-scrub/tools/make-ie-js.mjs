// 把面板前端从 ES6 转成 IE11 能跑的 ES5。
//
// 背景：vvn.exe 的内嵌窗口是 IE 内核，不支持模板字符串 / 箭头函数 /
// async-await / for..of / 可选链 / 空值合并。任何一处语法错误都会让整段
// 脚本不执行（页面只剩骨架），所以必须全量转换，不能漏。
//
// 策略：逐条做语法级替换，改完再用 node --check 验；不改变逻辑。
// 输入 app.js + index.html，输出 app.ie.js。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ui");
const srcPath = path.join(dir, "app.js");
const outPath = path.join(dir, "app.ie.js");

let src = fs.readFileSync(srcPath, "utf8");
const report = {};

/* ── 1. 模板字符串 → 字符串拼接 ─────────────────────────── */
// 处理 ` ... ${expr} ... ` 形式。嵌套的反引号不支持（源文件里没有）。
function templateToConcat(code) {
  let out = "";
  let i = 0;
  let count = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === "`") {
      // 找到配对的结束反引号（跳过 \` 转义）
      let j = i + 1;
      while (j < code.length) {
        if (code[j] === "\\") { j += 2; continue; }
        if (code[j] === "`") break;
        j += 1;
      }
      if (j >= code.length) { out += ch; i += 1; continue; }
      const inner = code.slice(i + 1, j);
      count += 1;
      out += "(" + templateBodyToConcat(inner) + ")";
      i = j + 1;
      continue;
    }
    // 跳过普通字符串，避免误伤里面的 ${}
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < code.length) {
        if (code[j] === "\\") { j += 2; continue; }
        if (code[j] === ch) break;
        j += 1;
      }
      out += code.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    // 跳过注释
    if (ch === "/" && code[i + 1] === "/") {
      let j = code.indexOf("\n", i);
      if (j < 0) j = code.length;
      out += code.slice(i, j);
      i = j;
      continue;
    }
    if (ch === "/" && code[i + 1] === "*") {
      let j = code.indexOf("*/", i);
      if (j < 0) j = code.length; else j += 2;
      out += code.slice(i, j);
      i = j;
      continue;
    }
    out += ch;
    i += 1;
  }
  report.templates = count;
  return out;
}

function templateBodyToConcat(body) {
  const parts = [];
  let buf = "";
  let i = 0;
  while (i < body.length) {
    if (body[i] === "\\" && body[i + 1] === "$") { buf += "$"; i += 2; continue; }
    if (body[i] === "$" && body[i + 1] === "{") {
      if (buf) { parts.push({ lit: buf }); buf = ""; }
      // 配平大括号
      let depth = 1;
      let j = i + 2;
      while (j < body.length && depth > 0) {
        if (body[j] === "{") depth += 1;
        else if (body[j] === "}") depth -= 1;
        if (depth === 0) break;
        j += 1;
      }
      parts.push({ expr: body.slice(i + 2, j) });
      i = j + 1;
      continue;
    }
    // 转义序列原样保留（\n \t 等交给 JS 字符串处理）
    if (body[i] === "\\") { buf += body[i] + (body[i + 1] || ""); i += 2; continue; }
    if (body[i] === '"') { buf += '\\"'; i += 1; continue; }
    buf += body[i];
    i += 1;
  }
  if (buf) parts.push({ lit: buf });

  if (parts.length === 0) return '""';
  return parts
    .map((p) => (p.lit !== undefined ? '"' + p.lit + '"' : "(" + p.expr + ")"))
    .join(" + ");
}

src = templateToConcat(src);

/* ── 2. 箭头函数 → function ─────────────────────────────── */
// 只处理常见形态：(a, b) => expr  /  (a) => { ... }  /  a => expr
let arrowCount = 0;
src = src.replace(/\(([^()]*)\)\s*=>\s*\{/g, (m, args) => { arrowCount += 1; return "function (" + args + ") {"; });
src = src.replace(/\b([A-Za-z_$][\w$]*)\s*=>\s*\{/g, (m, a) => { arrowCount += 1; return "function (" + a + ") {"; });
// 表达式体箭头函数：(a) => expr   →  function (a) { return expr; }
src = src.replace(/\(([^()]*)\)\s*=>\s*([^;{}\n]+)(?=[,;)\]\n])/g, (m, args, body) => {
  arrowCount += 1;
  return "function (" + args + ") { return " + body.trim() + "; }";
});
src = src.replace(/\b([A-Za-z_$][\w$]*)\s*=>\s*([^;{}\n]+)(?=[,;)\]\n])/g, (m, a, body) => {
  arrowCount += 1;
  return "function (" + a + ") { return " + body.trim() + "; }";
});
report.arrows = arrowCount;

/* ── 3. 可选链 ?. 与空值合并 ?? ─────────────────────────── */
// a?.b  →  (a == null ? undefined : a.b)
let optCount = 0;
src = src.replace(/([A-Za-z_$][\w$.\[\]]*)\?\.\s*([A-Za-z_$][\w$]*)/g, (m, obj, prop) => {
  optCount += 1;
  return "(" + obj + " == null ? undefined : " + obj + "." + prop + ")";
});
report.optional = optCount;

let nullishCount = 0;
// 只处理简单形态 a ?? b（带括号包裹，保证优先级正确）
src = src.replace(/([A-Za-z_$][\w$.\[\]]*|"[^"]*"|'[^']*'|\d+)\s*\?\?\s*([A-Za-z_$][\w$.\[\]]*|"[^"]*"|'[^']*'|\d+|\{\}|\[\])/g, (m, a, b) => {
  nullishCount += 1;
  return "(" + a + " !== null && " + a + " !== undefined ? " + a + " : " + b + ")";
});
report.nullish = nullishCount;

/* ── 4. for..of → 索引循环 ──────────────────────────────── */
let forOfCount = 0;
src = src.replace(/for\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+of\s+([^)]+)\)\s*\{/g, (m, v, iter) => {
  forOfCount += 1;
  const arr = "_it" + forOfCount;
  const idx = "_i" + forOfCount;
  return "for (var " + idx + " = 0, " + arr + " = (" + iter.trim() + ") || []; " +
         idx + " < (" + arr + ".length || 0); " + idx + "++) { var " + v + " = " + arr + "[" + idx + "];";
});
report.forOf = forOfCount;

/* ── 5. const / let → var ──────────────────────────────── */
src = src.replace(/\bconst\s+/g, "var ");
src = src.replace(/\blet\s+/g, "var ");

/* ── 6. .includes( → indexOf 判断 ───────────────────────── */
src = src.replace(/([A-Za-z_$][\w$.\[\]()]*|"[^"]*"|'[^']*')\.includes\(([^)]+)\)/g, "$1.indexOf($2) >= 0");

/* ── 7. Object.entries → 手写遍历 ───────────────────────── */
src = src.replace(/Object\.entries\(([^)]+)\)/g, "_entries($1)");

/* ── 8. 展开 ... 在函数调用里的用法 ─────────────────────── */
// 源文件里只有 4 处，逐个用 apply/concat 改写（见下方手工补丁）

/* ── 9. async / await → 回调链（最难的一块） ────────────── */
// 这里不自动改：async/await 改写必须理解控制流。先标记出来，由补丁段处理。
const asyncCount = (src.match(/\basync\s+function/g) || []).length;
const awaitCount = (src.match(/\bawait\b/g) || []).length;
report.async = asyncCount;
report.await = awaitCount;

const banner = [
  "// 自动生成：由 app.js 转换的 ES5 版本，给 vvn.exe 的内嵌窗口（IE 内核）用。",
  "// 改逻辑请改 app.js，然后重跑 tools/make-ie-js.mjs。",
  "// 转换统计：" + JSON.stringify(report),
  "",
  "/* IE11 垫片：源文件用到的一点点新 API */",
  "function _entries(o) { var r = []; for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) r.push([k, o[k]]); return r; }",
  "",
].join("\n");

fs.writeFileSync(outPath, banner + src, "utf8");
console.log("转换统计:", JSON.stringify(report, null, 1));
console.log("写入", outPath, fs.statSync(outPath).size, "字节");
console.log("");
console.log("还需人工处理: async/await", asyncCount, "处、await", awaitCount, "处、剩余展开运算符若干");