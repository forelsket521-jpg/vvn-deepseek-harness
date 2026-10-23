import fs from "node:fs";
const a=JSON.parse(fs.readFileSync("C:/Users/Administrator/Documents/deepseek-harness/default-workspace/re/dsh-purge/analysis.json","utf8"));
const map=new Map();
for(const r of a.rows) for(const f of r.files||[]){ if(!map.has(f.key)) map.set(f.key, []); const arr=map.get(f.key); const p=f.fp.replace(/\\/g,"/"); if(!arr.includes(p)) arr.push(p); }
for(const [k,v] of [...map].sort()) console.log(k.padEnd(34), v.join("  ||  "));
