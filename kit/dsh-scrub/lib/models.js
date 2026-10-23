// dsh-scrub · 模型配置（一键切换 / 新增通道 / 写密钥 / 连通性测试）
//
// 落点：profile 的 patch 层 —— <DSH_HOME>/profiles/<profile>/cordis.patch.yml
//   · agent-default-model: {provider, model, reasoningEffort}   ← 「一键换模型」写这里
//   · llm-pi-ai.config.providers.<name>: {displayName, apiKeyEnv, api, baseURL, models[]}
// 密钥：<DSH_HOME>/.credentials.yaml 的 refs.<ENV_NAME>（provider 里用 apiKeyEnv 引用）
//
// patch 层是启动时生效的，所以改完提示「重启 dsh」；写盘前备份，写盘后回读自检。

import fs from "node:fs";
import path from "node:path";
import { findDshHome } from "./locate.js";
import { readState, writeState } from "./state.js";
import {
  addProvider, getScalar, maskSecret, parseProviders, parseRefs, setRef, setScalar, toLines, verifyPatched,
} from "./yaml-lite.js";

const MODEL_BLOCK = "agent-default-model";
const PROVIDER_BLOCK = "llm-pi-ai";
const BAK = ".scrub-model.bak";

export function profilesDir(dshHome = findDshHome()) {
  return path.join(dshHome, "profiles");
}

export function listProfiles(dshHome = findDshHome()) {
  const dir = profilesDir(dshHome);
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, "cordis.patch.yml")))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export function profilePaths(profile, dshHome = findDshHome()) {
  const dir = path.join(profilesDir(dshHome), profile);
  return {
    dir,
    patch: path.join(dir, "cordis.patch.yml"),
    pkg: path.join(dir, "package.json"),
    credentials: path.join(dshHome, ".credentials.yaml"),
  };
}

function readText(fp) {
  try { return fs.readFileSync(fp, "utf8"); } catch { return null; }
}

export function readModelConfig({ profile = "desktop", dshHome = findDshHome() } = {}) {
  const p = profilePaths(profile, dshHome);
  const patch = readText(p.patch);
  const cred = readText(p.credentials) || "";
  const refs = parseRefs(cred);
  const providers = patch ? parseProviders(patch, PROVIDER_BLOCK) : [];
  const reasoningEffort = patch ? getScalar(patch, MODEL_BLOCK, "config.reasoningEffort") : null;
  const provider = patch ? getScalar(patch, MODEL_BLOCK, "config.provider") : null;
  const model = patch ? getScalar(patch, MODEL_BLOCK, "config.model") : null;

  let pkg = null;
  try { pkg = JSON.parse(readText(p.pkg) || "null"); } catch { /* ignore */ }

  return {
    profile,
    exists: Boolean(patch),
    patch_path: p.patch,
    credentials_path: p.credentials,
    has_backup: fs.existsSync(p.patch + BAK),
    current: { provider: provider || "", model: model || "", reasoningEffort: reasoningEffort || "" },
    providers: providers.map((pv) => ({
      ...pv,
      key_env: pv.apiKeyEnv || "",
      key_set: Boolean(pv.apiKeyEnv && refs[pv.apiKeyEnv]),
      key_mask: pv.apiKeyEnv ? maskSecret(refs[pv.apiKeyEnv]) : "",
      key_source: pv.apiKeyEnv && refs[pv.apiKeyEnv] ? "credentials" : (pv.apiKeyEnv && process.env[pv.apiKeyEnv] ? "env" : "none"),
    })),
    refs: Object.fromEntries(Object.entries(refs).map(([k, v]) => [k, maskSecret(v)])),
    bundles: pkg?.dsh?.profile?.bundles || [],
    updated: (() => { try { return fs.statSync(p.patch).mtime.toISOString(); } catch { return ""; } })(),
  };
}

function backupOnce(fp, text) {
  const bak = fp + BAK;
  if (fs.existsSync(bak)) return "kept";
  fs.writeFileSync(bak, text, "utf8");
  return "created";
}

function writeVerified(fp, before, after, check) {
  const verdict = check(before, after);
  if (!verdict.ok) return { ok: false, reason: verdict.reason };
  backupOnce(fp, before);
  const tmp = `${fp}.${process.pid}.${Date.now()}.scrubtmp`;
  fs.writeFileSync(tmp, after, "utf8");
  fs.renameSync(tmp, fp);
  return { ok: true };
}

/**
 * 一键换模型：只写 agent-default-model 的三个标量。
 * provider 的校验顺序：providers 映射 → 用过的历史（state.modelsHistory）→ 当前值 → 显式 allowUnknown。
 * 账号型 provider（不在 llm-pi-ai 里）靠后两条兜住，避免误写拼错的通道名。
 */
export function switchModel({ provider, model, reasoningEffort, profile = "desktop", dshHome = findDshHome(), allowUnknown = false } = {}) {
  const p = profilePaths(profile, dshHome);
  const before = readText(p.patch);
  if (!before) return { ok: false, reason: `没有 ${p.patch}` };
  if (!provider || !model) return { ok: false, reason: "provider 与 model 都必填" };
  if (!/^[A-Za-z0-9_.:-]+$/.test(provider) || !/^[A-Za-z0-9_.:/-]+$/.test(model)) {
    return { ok: false, reason: "provider / model 只能是字母数字与 _ . : / -" };
  }

  const known = parseProviders(before, PROVIDER_BLOCK);
  const target = known.find((x) => x.id === provider);
  const currentProvider = getScalar(before, MODEL_BLOCK, "config.provider") || "";
  const history = Array.isArray(readState(dshHome).modelsHistory) ? readState(dshHome).modelsHistory : [];
  const warnings = [];

  if (target) {
    if (!target.models.some((m) => m.id === model)) {
      return { ok: false, reason: `provider ${provider} 下没有模型 ${model}（可选：${target.models.map((m) => m.id).join(", ")}）` };
    }
  } else {
    const seenBefore = history.some((h) => h.provider === provider);
    const declared = [...before.matchAll(/^- id:\s*llm-([A-Za-z0-9_-]+)\s*$/gm)].map((m) => m[1]);
    if (!allowUnknown && provider !== currentProvider && !seenBefore) {
      return {
        ok: false,
        reason: `provider ${provider} 不在通道表里，也不是当前值/历史值${declared.length ? `（补丁层已声明：${declared.join("、")}）` : ""}；确认无误请勾选「允许未声明通道名」`,
        needs_confirm: true,
      };
    }
    warnings.push(`provider ${provider} 未在通道表内，未做模型名校验`);
  }

  let text = before;
  const steps = [];
  for (const [key, value] of [["config.provider", provider], ["config.model", model], ["config.reasoningEffort", reasoningEffort || ""]]) {
    if (key === "config.reasoningEffort" && !value) continue;
    const r = setScalar(text, MODEL_BLOCK, key, value);
    if (!r.ok) return { ok: false, reason: r.reason };
    steps.push(`${key}=${value}(${r.mode})`);
    text = r.text;
  }

  const written = writeVerified(p.patch, before, text, (b, a) => verifyPatched(b, a, MODEL_BLOCK, "config.model", model));
  if (!written.ok) return { ok: false, reason: written.reason };

  const nextHistory = [...history.filter((h) => !(h.provider === provider && h.model === model)), { provider, model, at: new Date().toISOString() }].slice(-12);
  try { writeState(dshHome, { modelsHistory: nextHistory }); } catch { /* 历史写不进去不影响主流程 */ }

  return { ok: true, applied: steps, warnings, restart_required: true, backup: p.patch + BAK };
}

/** 新增/覆盖一个 provider 通道。 */
export function addProviderChannel({ profile = "desktop", dshHome = findDshHome(), provider } = {}) {
  const p = profilePaths(profile, dshHome);
  const before = readText(p.patch);
  if (!before) return { ok: false, reason: `没有 ${p.patch}` };
  if (!provider || !provider.id) return { ok: false, reason: "provider.id 必填" };
  if (!provider.baseURL) return { ok: false, reason: "provider.baseURL 必填" };
  if (!provider.apiKeyEnv) return { ok: false, reason: "provider.apiKeyEnv 必填（密钥变量名）" };
  if (!Array.isArray(provider.models) || provider.models.length === 0) {
    return { ok: false, reason: "至少给一个模型 id" };
  }
  const existing = parseProviders(before, PROVIDER_BLOCK).find((x) => x.id === provider.id);
  if (existing) return { ok: false, reason: `provider ${provider.id} 已存在，先改它的 models 或换个名字` };

  const r = addProvider(before, provider, PROVIDER_BLOCK);
  if (!r.ok) return { ok: false, reason: r.reason };
  const after = r.text;

  const parsed = parseProviders(after, PROVIDER_BLOCK);
  const added = parsed.find((x) => x.id === provider.id);
  if (!added) return { ok: false, reason: "写入后回读不到新 provider" };
  if (added.baseURL !== provider.baseURL) return { ok: false, reason: `回读 baseURL 不一致：${added.baseURL}` };

  const written = writeVerified(p.patch, before, after, () => ({ ok: true }));
  if (!written.ok) return { ok: false, reason: written.reason };
  return { ok: true, provider: added, inserted_lines: r.inserted, restart_required: true };
}

/** 写 API Key（.credentials.yaml → refs.<name>）。 */
export function setApiKey({ profile = "desktop", dshHome = findDshHome(), name, value } = {}) {
  const p = profilePaths(profile, dshHome);
  if (!/^[A-Z][A-Z0-9_]*$/.test(String(name || ""))) return { ok: false, reason: "密钥变量名只允许大写字母/数字/下划线，且以字母开头" };
  if (!String(value || "").trim()) return { ok: false, reason: "密钥为空" };
  const before = readText(p.credentials);
  const base = before || "version: 1\nrecords:\nrefs:\n";
  const r = setRef(base, name, String(value).trim());
  if (!r.ok) return { ok: false, reason: r.reason };
  const after = r.text;
  const check = parseRefs(after);
  if (check[name] !== String(value).trim()) return { ok: false, reason: "回读密钥不一致" };

  if (before === null) {
    fs.mkdirSync(path.dirname(p.credentials), { recursive: true });
  } else if (!fs.existsSync(p.credentials + BAK)) {
    fs.writeFileSync(p.credentials + BAK, before, "utf8");
  }
  const tmp = `${p.credentials}.${process.pid}.${Date.now()}.scrubtmp`;
  fs.writeFileSync(tmp, after, "utf8");
  fs.renameSync(tmp, p.credentials);
  return { ok: true, mode: r.mode, restart_required: true };
}

/* ── 连通性测试 ───────────────────────────────────────────── */

function resolveKey({ name, dshHome }) {
  if (name && process.env[name]) return { key: process.env[name], source: "env" };
  const cred = readText(path.join(dshHome, ".credentials.yaml"));
  if (!cred) return { key: "", source: "none" };
  const refs = parseRefs(cred);
  if (name && refs[name]) return { key: refs[name], source: "credentials" };
  return { key: "", source: "none" };
}

function normaliseBase(url) {
  const s = String(url || "").trim().replace(/\/+$/, "");
  if (!s) return "";
  return /\/v\d+$/.test(s) ? s : s;
}

/**
 * 用一条最小请求探活：POST {baseURL}/chat/completions，max_tokens=1。
 * 只报告事实（状态码/耗时/错误摘要），不打印密钥。
 */
export async function testProvider({
  profile = "desktop", dshHome = findDshHome(), providerId, model, baseURL, apiKeyEnv, timeoutMs = 15000,
} = {}) {
  const cfg = readModelConfig({ profile, dshHome });
  const pv = cfg.providers.find((x) => x.id === providerId);
  const base = normaliseBase(baseURL || pv?.baseURL);
  const envName = apiKeyEnv || pv?.key_env || "";
  const modelId = model || pv?.models?.[0]?.id || "";
  if (!base) return { ok: false, reason: "没有 baseURL" };
  if (!modelId) return { ok: false, reason: "没有模型 id" };

  const { key, source } = resolveKey({ name: envName, dshHome });
  if (!key) return { ok: false, reason: `没有密钥（${envName || "apiKeyEnv 未填"}）：credentials 与环境变量都为空` };

  const url = `${base}/chat/completions`;
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: modelId, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false }),
      signal: ac.signal,
    });
    const ms = Date.now() - started;
    const text = await resp.text().catch(() => "");
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      if (j?.error?.message) detail = String(j.error.message).slice(0, 300);
      else if (j?.message) detail = `${j.code ? `${j.code} · ` : ""}${j.message}`.slice(0, 300);
      else if (j?.choices?.length) detail = `ok · ${j.choices[0]?.finish_reason || "choice"}`;
    } catch { /* 保留原文片段 */ }
    return {
      ok: resp.ok,
      status: resp.status,
      ms,
      url,
      model: modelId,
      key_source: source,
      detail,
    };
  } catch (e) {
    const ms = Date.now() - started;
    return {
      ok: false,
      status: 0,
      ms,
      url,
      model: modelId,
      key_source: source,
      detail: e?.name === "AbortError" ? `超时 ${timeoutMs}ms` : String(e?.message || e),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 列出该 provider 里可选模型（给面板下拉用）。 */
export function modelsOf(profile, providerId, dshHome = findDshHome()) {
  const cfg = readModelConfig({ profile, dshHome });
  const pv = cfg.providers.find((x) => x.id === providerId);
  return pv ? pv.models : [];
}

export { MODEL_BLOCK, PROVIDER_BLOCK, BAK };
