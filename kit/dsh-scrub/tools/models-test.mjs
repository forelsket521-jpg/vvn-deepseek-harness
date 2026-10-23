// 模型配置自测：真实 profile 只读，写操作全部在临时 DSH_HOME 的副本上做。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readModelConfig, switchModel, addProviderChannel, setApiKey, testProvider } from "../lib/models.js";
import { parseProviders, parseRefs, toLines } from "../lib/yaml-lite.js";
import { readModeState, writeModeState, listPresets } from "../lib/presets.js";
import { readRuleFile, saveRuleFile, removeRuleBlock, restoreRuleFile } from "../lib/workspace-rules.js";

const REAL_HOME = "C:/Users/Administrator/.dsh";
const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? "  " + extra : ""}`);
};

/* 1. 读真实配置 */
const cfg = readModelConfig({ profile: "desktop", dshHome: REAL_HOME });
check("读到 profile", cfg.exists, cfg.patch_path);
check("provider 数量 > 0", cfg.providers.length > 0, `${cfg.providers.length} 个：${cfg.providers.map((p) => p.id).join(",")}`);
check("当前默认模型", Boolean(cfg.current.provider && cfg.current.model), `${cfg.current.provider}/${cfg.current.model} · effort=${cfg.current.reasoningEffort}`);
check("密钥状态可读", cfg.providers.every((p) => typeof p.key_set === "boolean"), cfg.providers.map((p) => `${p.id}:${p.key_source}`).join(" "));
check("模型清单非空", cfg.providers.some((p) => p.models.length > 0), cfg.providers.map((p) => `${p.id}(${p.models.length})`).join(" "));

/* 2. 临时 DSH_HOME 上做写操作 */
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "scrub-models-"));
const profDir = path.join(tmpHome, "profiles", "desktop");
fs.mkdirSync(profDir, { recursive: true });
const srcPatch = path.join(REAL_HOME, "profiles", "desktop", "cordis.patch.yml");
fs.copyFileSync(srcPatch, path.join(profDir, "cordis.patch.yml"));
if (fs.existsSync(path.join(REAL_HOME, ".credentials.yaml"))) {
  fs.copyFileSync(path.join(REAL_HOME, ".credentials.yaml"), path.join(tmpHome, ".credentials.yaml"));
}

const before = fs.readFileSync(path.join(profDir, "cordis.patch.yml"), "utf8");
const commentsBefore = toLines(before).filter((l) => l.trim().startsWith("#")).length;

const target = cfg.providers.find((p) => p.models.length > 0 && p.id !== cfg.current.provider) || cfg.providers.find((p) => p.models.length > 0);
const targetModel = target.models[0].id;
const sw = switchModel({ profile: "desktop", dshHome: tmpHome, provider: target.id, model: targetModel, reasoningEffort: "high" });
check("切换模型成功", sw.ok, sw.ok ? sw.applied.join(" ") : sw.reason);

const after = fs.readFileSync(path.join(profDir, "cordis.patch.yml"), "utf8");
check("回读一致", readModelConfig({ profile: "desktop", dshHome: tmpHome }).current.provider === target.id);
check("注释保留", toLines(after).filter((l) => l.trim().startsWith("#")).length === commentsBefore, `${commentsBefore} 行注释`);
check("备份已生成", fs.existsSync(path.join(profDir, "cordis.patch.yml.scrub-model.bak")));

const bad = switchModel({ profile: "desktop", dshHome: tmpHome, provider: "no-such", model: "x" });
check("拒绝未知 provider", !bad.ok, bad.reason);

const ap = addProviderChannel({
  profile: "desktop", dshHome: tmpHome,
  provider: {
    id: "scrub-test", displayName: "测试通道", apiKeyEnv: "SCRUB_TEST_KEY", api: "openai-completions",
    baseURL: "https://example.invalid/v1",
    models: [{ id: "demo-model", name: "Demo", contextWindow: 100000, maxTokens: 8192, input: ["text"] }],
  },
});
check("新增 provider", ap.ok, ap.ok ? `插入 ${ap.inserted_lines} 行` : ap.reason);
const parsedAfter = parseProviders(fs.readFileSync(path.join(profDir, "cordis.patch.yml"), "utf8"));
check("新 provider 可解析", parsedAfter.some((p) => p.id === "scrub-test" && p.baseURL === "https://example.invalid/v1"));

const dup = addProviderChannel({
  profile: "desktop", dshHome: tmpHome,
  provider: { id: "scrub-test", apiKeyEnv: "X", baseURL: "https://x", models: [{ id: "a" }] },
});
check("拒绝重复 provider", !dup.ok, dup.reason);

const key = setApiKey({ profile: "desktop", dshHome: tmpHome, name: "SCRUB_TEST_KEY", value: "sk-test-1234567890" });
check("写入密钥", key.ok, key.mode);
check("密钥可回读", parseRefs(fs.readFileSync(path.join(tmpHome, ".credentials.yaml"), "utf8")).SCRUB_TEST_KEY === "sk-test-1234567890");
const badKey = setApiKey({ profile: "desktop", dshHome: tmpHome, name: "bad-name", value: "x" });
check("拒绝非法变量名", !badKey.ok, badKey.reason);

/* 3. 连通性测试（指向无效地址，期望快速失败且有可读原因） */
const t = await testProvider({ profile: "desktop", dshHome: tmpHome, providerId: "scrub-test", timeoutMs: 5000 });
check("连通性测试有结论", typeof t.ok === "boolean", `ok=${t.ok} status=${t.status} ${String(t.detail || t.reason).slice(0, 80)}`);

const t2 = await testProvider({ profile: "desktop", dshHome: tmpHome, providerId: "scrub-test", apiKeyEnv: "NO_SUCH_KEY", timeoutMs: 3000 });
check("缺密钥时报错清楚", !t2.ok && /没有密钥/.test(String(t2.reason || t2.detail || "")), String(t2.reason || t2.detail).slice(0, 60));

/* 4. 预设与注入模式 */
const presets = listPresets(REAL_HOME);
check("列出预设", Array.isArray(presets), presets.map((p) => p.id).join(","));
const modeWrite = writeModeState({ dshHome: tmpHome, mode: "minimal", tail: "尾部段", preset: "standard" });
check("写注入模式", modeWrite.ok);
check("模式可回读", readModeState(tmpHome).mode === "minimal" && readModeState(tmpHome).tail === "尾部段");
const badMode = writeModeState({ dshHome: tmpHome, mode: "nope" });
check("拒绝非法模式", !badMode.ok);

/* 5. 工作区规则 */
const ws = path.join(tmpHome, "ws");
fs.mkdirSync(ws, { recursive: true });
fs.writeFileSync(path.join(ws, "AGENTS.md"), "# 已有内容\n\n保留我。\n", "utf8");
const saved = saveRuleFile({ scope: "workspace", target: "AGENTS.md", text: "- 规则一\n- 规则二", dshHome: tmpHome, workspace: ws });
check("写入规则段", saved.ok, saved.reason || "");
const gotRule = readRuleFile({ scope: "workspace", target: "AGENTS.md", dshHome: tmpHome, workspace: ws });
check("读回规则段", gotRule.has_block && gotRule.block.includes("规则二"));
check("保留原文", fs.readFileSync(path.join(ws, "AGENTS.md"), "utf8").includes("保留我。"));
check("规则备份存在", gotRule.has_backup);
const saved2 = saveRuleFile({ scope: "workspace", target: "AGENTS.md", text: "- 只留一条", dshHome: tmpHome, workspace: ws });
check("二次写入不重复叠加", saved2.ok && (fs.readFileSync(path.join(ws, "AGENTS.md"), "utf8").match(/scrub:rules:begin/g) || []).length === 1);
const removed = removeRuleBlock({ scope: "workspace", target: "AGENTS.md", dshHome: tmpHome, workspace: ws });
check("移除规则段", removed.ok);
const restored = restoreRuleFile({ scope: "workspace", target: "AGENTS.md", dshHome: tmpHome, workspace: ws });
check("从备份还原", restored.ok);

fs.rmSync(tmpHome, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? " · failed: " + failed.map((f) => f.name).join(", ") : ""}`);
if (failed.length) process.exitCode = 1;
