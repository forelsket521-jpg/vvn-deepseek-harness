// 插件入口冒烟测试：假 ctx 里跑 apply()，看段与工具是否按时注册。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "scrub-plugin-"));
process.env.DSH_HOME = home;
process.env.DSH_SURFACE = "web";

const mod = await import("../lib/index.js");

const sections = [];
const tools = [];
const disposers = [];

const ctx = {
  systemPrompt: null,
  tools: { register: (t) => tools.push(t) },
  effect: (fn) => { const d = fn(); if (typeof d === "function") disposers.push(d); },
  inject: (names, fn) => { /* webServer 不存在：跳过面板注册 */ },
  on: () => {},
};
ctx.systemPrompt = {
  ctx,
  section: (spec) => {
    sections.push({ name: spec.name, order: spec.order, text: typeof spec.text === "function" ? spec.text({ agent: {} }) : spec.text });
    return () => {};
  },
};

mod.apply(ctx, { verbose: false, panel: false });

const names = sections.map((s) => s.name);
const toolNames = tools.map((t) => t.name);
const core = sections.find((s) => s.name === "scrub-core");
const caps = sections.find((s) => s.name === "scrub-caps");

const checks = [
  ["导出名", mod.name === "dsh-scrub"],
  ["注入声明", Array.isArray(mod.inject) && mod.inject.includes("systemPrompt")],
  ["注册 scrub-core", names.includes("scrub-core")],
  ["注册 scrub-caps", names.includes("scrub-caps")],
  ["core 段非空", Boolean(core && core.text.length > 1000)],
  ["core 段有信封", Boolean(core && core.text.startsWith("<|im_start|>system:"))],
  ["caps 段有内容", Boolean(caps && caps.text.includes("能力选用"))],
  ["工具四件套", ["scrub_status", "scrub_apply", "scrub_revert", "scrub_prompt"].every((n) => toolNames.includes(n))],
  ["工具带 schema", tools.every((t) => t.parameters && t.output && typeof t.execute === "function")],
  ["order 靠前", Boolean(core && core.order <= -100000)],
];

let ok = 0;
for (const [label, pass] of checks) {
  console.log(`${pass ? "PASS" : "FAIL"} ${label}`);
  if (pass) ok += 1;
}

// 顺带跑一次工具：scrub_status 应当能出文本
const statusTool = tools.find((t) => t.name === "scrub_status");
const out = await statusTool.execute({});
const statusOk = typeof out?.text === "string" && /SCRUB/.test(out.text);
console.log(`${statusOk ? "PASS" : "FAIL"} scrub_status 可执行`);
if (statusOk) ok += 1;

fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${ok}/${checks.length + 1} passed`);
if (ok !== checks.length + 1) process.exitCode = 1;
