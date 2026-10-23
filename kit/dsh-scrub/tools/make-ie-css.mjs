// 把 style.css 的 CSS 变量展开成字面值，产出 IE 可用的 style.ie.css。
// 只做一件事：解析 :root 里的 --x: v; 然后把 var(--x) 替换成 v。
// 保留原文件不动，输出新文件，便于随时回退。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ui");
const src = path.join(dir, "style.css");
const out = path.join(dir, "style.ie.css");

let css = fs.readFileSync(src, "utf8");

// 1) 收集变量定义（只在 :root 块里）
const vars = {};
const rootMatch = css.match(/:root\s*\{([\s\S]*?)\}/);
if (rootMatch) {
  for (const line of rootMatch[1].split("\n")) {
    const m = line.match(/^\s*(--[\w-]+)\s*:\s*(.+?);\s*$/);
    if (m) vars[m[1]] = m[2].trim();
  }
}
console.log(`收集到 ${Object.keys(vars).length} 个变量`);

// 2) 反复展开 var()，处理嵌套（var 里引用 var 的情况）
let guard = 0;
while (/var\(--/.test(css) && guard < 10) {
  css = css.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (all, name, fallback) => {
    if (vars[name] !== undefined) return vars[name];
    if (fallback !== undefined) return fallback.trim();
    console.warn(`  未定义变量 ${name}，保留原样`);
    return all;
  });
  guard += 1;
}

// 3) 删掉 :root 块本身（值已展开，留着也没有副作用，但 IE 不认识变量声明也无害）
//    这里保留，因为里面还有 var 之外的东西时不该丢。实测只有变量，所以整体移除。
css = css.replace(/:root\s*\{[\s\S]*?\}\s*/, "");

// 4) 补一条 IE 友好的基础样式
const banner = `/* 自动生成：由 style.css 展开 CSS 变量而来。IE 不支持 var()，这份给内嵌窗口用。 */
/* 源文件：style.css，改动请改源文件后重跑 make-ie-css.mjs */\n`;

fs.writeFileSync(out, banner + css, "utf8");

const remain = (css.match(/var\(--/g) || []).length;
console.log(`写入 ${out}`);
console.log(`剩余未展开 var(): ${remain}`);
console.log(`字节：${fs.statSync(out).size}（原 ${fs.statSync(src).size}）`);