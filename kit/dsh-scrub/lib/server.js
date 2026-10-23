// dsh-scrub · HTTP 桥 + 静态面板
// 同一套 handler 供两处使用：
//   1. 插件内 ctx.webServer.register（prefix 路由）；
//   2. CLI `scrub serve` 的独立 node:http 服务（离线看状态/改配置）。
// 面板是自带的单页（ui/），不依赖宿主前端运行时，也不往官方设置页里塞东西。

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { findDshHome, detectSurface, pickAiBase } from "./locate.js";
import { gatherState, opApply, opRevert, readPrompt, savePrompt, reseedPrompt, importFromPurge } from "./state.js";
import { allPatches, patchById, survey, tally, readManifest, scrubbedHome, bakPath } from "./engine.js";
import { shapePrompt, defaultPrompt, normalizeEnvelope, escapeInterpolation, stripEnvelopeTags } from "./prompt.js";
import {
  readModelConfig, switchModel, addProviderChannel, setApiKey, testProvider, listProfiles,
} from "./models.js";
import { presetsSnapshot, writeModeState } from "./presets.js";
import { readRuleFile, saveRuleFile, removeRuleBlock, restoreRuleFile, RULE_TARGETS } from "./workspace-rules.js";
import { runVerify } from "./verify.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(HERE, "..", "ui");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendFile(res, fp) {
  fs.readFile(fp, (err, buf) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(fp).toLowerCase()] || "application/octet-stream",
      "cache-control": "no-store",
      "content-length": buf.length,
    });
    res.end(buf);
  });
}

function readBody(req, cap = 2 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > cap) {
        const err = new Error("body too large");
        reject(err);
        try { req.destroy(err); } catch { /* ignore */ }
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** 同源校验：只放行本机同源请求，挡掉浏览器里的跨站 POST。 */
export function sameOrigin(req) {
  const h = req.headers || {};
  if (String(h["sec-fetch-site"] || "").toLowerCase() === "cross-site") return false;
  const origin = String(h.origin || "").trim();
  if (origin === "null") return false;
  if (!origin) return true;
  let host = "";
  try { host = new URL(origin).host; } catch { return false; }
  return Boolean(h.host) && host.toLowerCase() === String(h.host).toLowerCase();
}

/* ── 注入稿体检 ───────────────────────────────────────────── */

function promptHealth(text) {
  const raw = String(text ?? "");
  const envelope = normalizeEnvelope(raw);
  const escaped = escapeInterpolation(envelope);
  const problems = [];
  if (!raw.trim()) problems.push("正文为空");
  if (!/^<\|im_start\|>system:/.test(raw.trim())) problems.push("缺少 <|im_start|>system: 信封头（注入时不会自动补）");
  if (!/<\/project_instructions>/.test(raw)) problems.push("缺少 </project_instructions>（整形时会自动补齐）");
  if (/\{\{(?!cwd\}\}|model\}\}|provider\}\})/.test(raw)) problems.push("含非法 {{…}} 插值（会被转义成 { {…} }）");
  const strippedTags = stripEnvelopeTags(raw).length !== raw.length;
  return {
    bytes: raw.length,
    lines: raw.split("\n").length,
    paragraphs: raw.split(/\n\s*\n/).filter((s) => s.trim()).length,
    shaped_bytes: shapePrompt(raw, {}).length,
    changed_by_shape: shapePrompt(raw, {}) !== raw.trim(),
    escaped_interp: escaped !== envelope,
    has_envelope: /^<\|im_start\|>system:/.test(raw.trim()),
    closed: /<\/project_instructions>/.test(raw),
    nested_tags: strippedTags,
    problems,
  };
}

/* ── 路由处理 ─────────────────────────────────────────────── */

export function createHandler({ dshHome = null, surface = null } = {}) {
  const home = () => dshHome || findDshHome();
  const surf = () => surface || detectSurface();

  return async function handle(req, res, urlIn) {
    const url = new URL(urlIn || req.url || "/", "http://127.0.0.1");
    const p = url.pathname;

    if (p === "/scrub" || p === "/scrub/" || p === "/scrub/index.html") {
      return sendFile(res, path.join(UI_DIR, "index.html"));
    }
    if (p === "/scrub/app.js") {
      // 内嵌窗口是 IE 内核，只认 ES5；app.ie.js 是它的专用版本。
      const ie = path.join(UI_DIR, "app.ie.js");
      return sendFile(res, fs.existsSync(ie) ? ie : path.join(UI_DIR, "app.js"));
    }
    if (p === "/scrub/app.es6.js") return sendFile(res, path.join(UI_DIR, "app.js"));
    // 样式表：优先给 IE 兼容版（CSS 变量已展开）。
    // 内置窗口是 IE 内核，不认识 var()；现代浏览器对展开版也完全兼容，
    // 所以统一发这一份，省掉 UA 判断。
    if (p === "/scrub/style.css") {
      const ie = path.join(UI_DIR, "style.ie.css");
      return sendFile(res, fs.existsSync(ie) ? ie : path.join(UI_DIR, "style.css"));
    }

    /* ── GET ──────────────────────────────────────────────── */
    if (req.method === "GET") {
      try {
        // 轻量探活：不碰磁盘、不建状态，启动器用它判断"服务起没起"。
        // 之前拿 /scrub/ 整页探测，会顺带触发状态扫描，白等十几秒。
        if (p === "/scrub/api/ping") {
          res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
          return res.end("vvn");
        }
        if (p === "/scrub/api/state") {
          const st = await gatherState({ dshHome: home(), surface: surf() });
          return sendJson(res, 200, {
            ok: true,
            ...st,
            catalog: allPatches().map((x) => ({
              id: x.id, name: x.name, layer: x.layer, desc: x.desc, keys: x.keys,
              optional: Boolean(x.optional), soft: Boolean(x.soft), surfaces: x.surfaces || null,
            })),
          });
        }
        if (p === "/scrub/api/models") {
          const profile = url.searchParams.get("profile") || "desktop";
          return sendJson(res, 200, {
            ok: true,
            profiles: listProfiles(home()),
            ...readModelConfig({ profile, dshHome: home() }),
          });
        }
        if (p === "/scrub/api/presets") {
          return sendJson(res, 200, { ok: true, ...presetsSnapshot(home()) });
        }
        if (p === "/scrub/api/rules") {
          const scope = url.searchParams.get("scope") || "global";
          const target = url.searchParams.get("target") || "AGENTS.md";
          return sendJson(res, 200, {
            ok: true,
            targets: RULE_TARGETS,
            ...readRuleFile({ scope, target, dshHome: home(), workspace: process.cwd() }),
          });
        }
        if (p === "/scrub/api/audit") {
          const manifest = await readManifest(home(), 120);
          const base = pickAiBase({ dshHome: home() });
          const files = base ? (await gatherState({ dshHome: home(), surface: surf(), includeFiles: false })) : null;
          const backups = [];
          try {
            const dirs = [path.join(home(), "profiles")];
            const walk = (d, depth) => {
              if (depth > 4) return;
              let entries = [];
              try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
              for (const e of entries) {
                const fp = path.join(d, e.name);
                if (e.isDirectory()) walk(fp, depth + 1);
                else if (e.name.endsWith(".scrbak") || e.name.endsWith(".scrub-model.bak") || e.name.endsWith(".scrub-rule.bak")) {
                  try { backups.push({ path: fp, bytes: fs.statSync(fp).size, mtime: fs.statSync(fp).mtime.toISOString() }); } catch { /* ignore */ }
                }
              }
            };
            for (const d of dirs) walk(d, 0);
          } catch { /* ignore */ }
          return sendJson(res, 200, { ok: true, manifest, backups, counts: files?.counts || null });
        }
        if (p === "/scrub/api/verify") {
          const profile = url.searchParams.get("profile") || "desktop";
          return sendJson(res, 200, { ok: true, ...(await runVerify({ dshHome: home(), surface: surf(), profile })) });
        }
        if (p === "/scrub/api/prompt") {
          const pr = readPrompt(home());
          return sendJson(res, 200, { ok: true, text: pr.text, path: pr.path, health: promptHealth(pr.text) });
        }
        return sendJson(res, 404, { ok: false, error: "not found" });
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: String(e && e.message || e) });
      }
    }

    /* ── POST ─────────────────────────────────────────────── */
    if (p === "/scrub/api/op") {
      if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "仅支持 POST" });
      if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, error: "跨站请求已拒绝" });
      let body;
      try {
        body = JSON.parse((await readBody(req)) || "{}");
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: `JSON 解析失败：${e.message}` });
      }
      const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter((n) => Number.isFinite(n)) : [];
      const profile = body.profile || "desktop";

      try {
        switch (body.op) {
          /* 清洗 */
          case "apply": {
            const out = await opApply({ dshHome: home(), surface: surf(), ids, dryRun: Boolean(body.dryRun) });
            return sendJson(res, out.ok ? 200 : 400, out);
          }
          case "revert": {
            const out = await opRevert({ dshHome: home(), ids });
            return sendJson(res, out.ok ? 200 : 400, out);
          }
          case "survey": {
            const st = await gatherState({ dshHome: home(), surface: surf(), ids: ids.length ? ids : null });
            return sendJson(res, 200, { ok: true, ...st });
          }
          case "patch-detail": {
            const patch = patchById(body.id);
            if (!patch) return sendJson(res, 404, { ok: false, error: "没有这条补丁" });
            const base = pickAiBase({ dshHome: home() });
            if (!base) return sendJson(res, 400, { ok: false, error: "找不到 @deepseek-ai 根" });
            const rows = await survey({ aiBase: base, dshHome: home(), surface: surf(), ids: [patch.id] });
            return sendJson(res, 200, {
              ok: true,
              patch: {
                id: patch.id, name: patch.name, layer: patch.layer, desc: patch.desc,
                optional: Boolean(patch.optional), soft: Boolean(patch.soft), surfaces: patch.surfaces || null,
              },
              needles: patch.needles.map((n, i) => ({
                i: i + 1,
                kind: n.pattern instanceof RegExp ? "正则" : "文本",
                pattern: String(n.pattern instanceof RegExp ? n.pattern.source : n.pattern).slice(0, 800),
                replace: n.replace.slice(0, 400),
              })),
              markers: (patch.markers || (patch.marker ? [patch.marker] : [])).map(String),
              row: rows[0] || null,
            });
          }
          case "report-export": {
            const st = await gatherState({ dshHome: home(), surface: surf() });
            const file = path.join(scrubbedHome(home()), `report-${Date.now()}.json`);
            fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...st }, null, 2), "utf8");
            return sendJson(res, 200, { ok: true, path: file, bytes: fs.statSync(file).size });
          }

          /* 模型 */
          case "model-switch": {
            const r = switchModel({
              profile, dshHome: home(),
              provider: String(body.provider || ""),
              model: String(body.model || ""),
              reasoningEffort: body.reasoningEffort ? String(body.reasoningEffort) : "",
              allowUnknown: Boolean(body.allowUnknown),
            });
            return sendJson(res, r.ok ? 200 : 400, { ...r, config: readModelConfig({ profile, dshHome: home() }) });
          }
          case "model-add": {
            const r = addProviderChannel({
              profile, dshHome: home(),
              provider: {
                id: String(body.id || "").trim(),
                displayName: String(body.displayName || "").trim(),
                baseURL: String(body.baseURL || "").trim(),
                apiKeyEnv: String(body.apiKeyEnv || "").trim(),
                api: String(body.api || "openai-completions"),
                models: Array.isArray(body.models) ? body.models : [],
              },
            });
            return sendJson(res, r.ok ? 200 : 400, { ...r, config: readModelConfig({ profile, dshHome: home() }) });
          }
          case "model-key": {
            const r = setApiKey({ profile, dshHome: home(), name: String(body.name || ""), value: String(body.value || "") });
            return sendJson(res, r.ok ? 200 : 400, { ...r, config: readModelConfig({ profile, dshHome: home() }) });
          }
          case "model-test": {
            const r = await testProvider({
              profile, dshHome: home(),
              providerId: body.providerId ? String(body.providerId) : undefined,
              model: body.model ? String(body.model) : undefined,
              baseURL: body.baseURL ? String(body.baseURL) : undefined,
              apiKeyEnv: body.apiKeyEnv ? String(body.apiKeyEnv) : undefined,
              timeoutMs: Number(body.timeoutMs) > 0 ? Number(body.timeoutMs) : 15000,
            });
            return sendJson(res, 200, r);
          }

          /* 注入稿 */
          case "prompt-get": {
            const pr = readPrompt(home());
            return sendJson(res, 200, { ok: true, text: pr.text, path: pr.path, preview: shapePrompt(pr.text, {}), health: promptHealth(pr.text) });
          }
          case "prompt-save": {
            const text = String(body.text ?? "");
            const st = savePrompt(home(), text);
            return sendJson(res, 200, { ok: true, state: st, health: promptHealth(text) });
          }
          case "prompt-reseed": {
            const st = reseedPrompt(home());
            const text = readPrompt(home()).text;
            return sendJson(res, 200, { ok: true, state: st, text, health: promptHealth(text) });
          }
          case "prompt-import": {
            const r = importFromPurge(home());
            return sendJson(res, r.ok ? 200 : 400, { ok: r.ok, ...r });
          }
          case "preview": {
            const text = String(body.text ?? readPrompt(home()).text);
            const mode = String(body.mode || "complete");
            return sendJson(res, 200, {
              ok: true,
              rendered: shapePrompt(text, {
                redteam: mode === "redteam",
                minimal: mode === "minimal",
              }),
            });
          }

          /* 预设 / 模式 */
          case "mode-set": {
            const r = writeModeState({
              dshHome: home(),
              mode: body.mode === undefined ? undefined : String(body.mode),
              tail: body.tail === undefined ? undefined : String(body.tail),
              preset: body.preset === undefined ? undefined : String(body.preset),
            });
            return sendJson(res, r.ok ? 200 : 400, { ...r, snapshot: presetsSnapshot(home()) });
          }

          /* 工作区规则 */
          case "rules-save": {
            const r = saveRuleFile({
              scope: String(body.scope || "global"),
              target: String(body.target || "AGENTS.md"),
              text: String(body.text ?? ""),
              dshHome: home(),
              workspace: process.cwd(),
            });
            return sendJson(res, r.ok ? 200 : 400, r);
          }
          case "rules-remove": {
            const r = removeRuleBlock({
              scope: String(body.scope || "global"),
              target: String(body.target || "AGENTS.md"),
              dshHome: home(),
              workspace: process.cwd(),
            });
            return sendJson(res, r.ok ? 200 : 400, r);
          }
          case "rules-restore": {
            const r = restoreRuleFile({
              scope: String(body.scope || "global"),
              target: String(body.target || "AGENTS.md"),
              dshHome: home(),
              workspace: process.cwd(),
            });
            return sendJson(res, r.ok ? 200 : 400, r);
          }

          /* 审计 */
          case "backups-clean": {
            const removed = [];
            const st = await gatherState({ dshHome: home(), surface: surf() });
            for (const fp of st.backup_files || []) {
              try { fs.unlinkSync(fp); removed.push(fp); } catch { /* ignore */ }
            }
            return sendJson(res, 200, { ok: true, removed: removed.length });
          }
          default:
            return sendJson(res, 400, { ok: false, error: `未知操作：${body.op}` });
        }
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: String(e && e.message || e) });
      }
    }

    return sendJson(res, 404, { ok: false, error: "not found" });
  };
}

/* ── 独立服务（CLI scrub serve） ──────────────────────────── */

export function startStandalone({ port = 43190, dshHome = null, surface = null, host = "127.0.0.1" } = {}) {
  const handle = createHandler({ dshHome, surface });
  const server = http.createServer((req, res) => {
    handle(req, res, req.url).catch((e) => {
      try { sendJson(res, 500, { ok: false, error: String(e && e.message || e) }); } catch { /* ignore */ }
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve({ server, port, url: `http://${host}:${port}/scrub/` }));
  });
}

/* ── 嵌入宿主 webServer ──────────────────────────────────── */

export function registerRoutes(webServer, { dshHome = null, surface = null } = {}) {
  const handle = createHandler({ dshHome, surface });
  const specs = [
    { kind: "prefix", path: "/scrub", label: "dsh-scrub: 面板" },
    { kind: "prefix", path: "/scrub/api/state", label: "dsh-scrub: 状态" },
    { kind: "prefix", path: "/scrub/api/models", label: "dsh-scrub: 模型" },
    { kind: "prefix", path: "/scrub/api/presets", label: "dsh-scrub: 预设" },
    { kind: "prefix", path: "/scrub/api/rules", label: "dsh-scrub: 规则" },
    { kind: "prefix", path: "/scrub/api/audit", label: "dsh-scrub: 审计" },
    { kind: "prefix", path: "/scrub/api/prompt", label: "dsh-scrub: 注入稿" },
    { kind: "prefix", path: "/scrub/api/op", label: "dsh-scrub: 操作" },
  ];
  const disposers = [];
  for (const spec of specs) {
    try {
      const d = webServer.register(
        { kind: spec.kind, path: spec.path, handler: (req, res) => handle(req, res, req.url) },
        spec.label,
      );
      if (typeof d === "function") disposers.push(d);
    } catch {
      /* 路由已存在（reload）时忽略 */
    }
  }
  return () => {
    for (const d of disposers.reverse()) {
      try { d(); } catch { /* ignore */ }
    }
  };
}

export { tally, bakPath };
