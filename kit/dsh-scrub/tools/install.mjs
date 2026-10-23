// dsh-scrub 安装器：把包放进 profile 的 node_modules，并往 profile 的 cordis.patch.yml 追加 insert。
// 默认 dry-run；--apply 才落盘（落盘前备份 profile 的 cordis.patch.yml）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findDshHome } from "../lib/locate.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");

const argv = process.argv.slice(2);
const argOf = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const apply = argv.includes("--apply");
const profile = argOf("--profile", "desktop");
const home = findDshHome();
const profileDir = path.join(home, "profiles", profile);
const dest = path.join(profileDir, "node_modules", "dsh-scrub");
const patchFile = path.join(profileDir, "cordis.patch.yml");

console.log(`scrub install · ${apply ? "APPLY" : "DRY-RUN"}`);
console.log(`  source  ${pkgRoot}`);
console.log(`  target  ${dest}`);
console.log(`  patch   ${patchFile}`);

if (!fs.existsSync(profileDir)) {
  console.error(`  ✗ profile 不存在：${profileDir}`);
  process.exit(1);
}

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d);
  }
}

const INSERT_ID = "- id: dsh-scrub";
let yml = "";
try {
  yml = fs.readFileSync(patchFile, "utf8");
} catch {
  console.log("  · profile 没有 cordis.patch.yml，将新建");
}

const block = `
# ── dsh-scrub（安装器追加）────────────────────────────────
- insert:
    - id: dsh-scrub
      name: 'dsh-scrub'
      inject: [systemPrompt, tools]
      config:
        enabled: true
        injected: true
        caps: true
        panel: true
        order: -100000
        verbose: false
`;

const already = yml.includes(INSERT_ID);
console.log(`  copy    ${already ? "包内容照抄" : "首次安装"}`);
console.log(`  patch   ${already ? "已存在 dsh-scrub 段，跳过" : "追加 insert 段"}`);

if (!apply) {
  console.log("\n  dry-run：确认无误后加 --apply 落盘");
  console.log("  注意：cordis.patch.yml 里若还留着 dsh-purge 的插入段，两套会同时注入；建议先删掉旧的或让它 disabled。");
  process.exit(0);
}

copyTree(pkgRoot, dest);
console.log(`  ✓ 已复制到 ${dest}`);

if (!already) {
  if (yml) fs.writeFileSync(`${patchFile}.scrub-install.bak`, yml, "utf8");
  fs.writeFileSync(patchFile, `${yml}${yml.endsWith("\n") || !yml ? "" : "\n"}${block}`, "utf8");
  console.log(`  ✓ 已追加 insert 段${yml ? `（备份 ${path.basename(patchFile)}.scrub-install.bak）` : ""}`);
}

console.log("\n完成。重启 dsh 后：面板 /scrub/ · 工具 scrub_status。");
