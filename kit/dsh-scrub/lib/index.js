// dsh-scrub · 插件入口
// 与 dsh-purge 的功能对应关系：
//   提示词注入段   → 本节注册 scrub-core / scrub-caps（不同 section 名，同一注入位置）
//   purge_* 工具   → scrub_status / scrub_apply / scrub_revert / scrub_prompt
//   设置页面板     → 自带 /scrub 单页作战台（不往官方设置页塞卡片）
//   82 条补丁      → 同一份数据（lib/table.data.js），执行器自研（lib/engine.js）
//   密封默认稿     → ChaCha20-Poly1305 + brotli + xor 掩码（lib/vault.js）

import { findDshHome, detectSurface, pickAiBase } from "./locate.js";
import { allPatches, patchById, survey, tally } from "./engine.js";
import {
  gatherState, opApply, opRevert, readPrompt, savePrompt, reseedPrompt, importFromPurge, promptPath,
} from "./state.js";
import { shapePrompt, capsText, isMinimalPreset, isRedteamPreset, SECTIONS } from "./prompt.js";
import { readModeState } from "./presets.js";
import { registerRoutes } from "./server.js";

export const name = "dsh-scrub";

// 只依赖提示词与工具；webServer 走 ctx.inject 延后获取，避免缺服务时插件挂死。
export const inject = ["systemPrompt", "tools"];

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  injected: true,
  caps: true,
  order: -100000,
  tailPrompt: "",
  tailOrder: 5100,
  panel: true,
  verbose: false,
});

const ORDER_CORE = -100000;

function cfgOf(config) {
  return { ...DEFAULT_CONFIG, ...(config || {}) };
}

/* ── 提示词段 ─────────────────────────────────────────────── */

function currentPreset(context) {
  const agent = context?.agent;
  const ctx = agent?.ctx || context?.ctx;
  try {
    const presets = ctx && typeof ctx.get === "function" ? ctx.get("agentPresets") : ctx?.agentPresets;
    if (presets && typeof presets.composedPreset === "function") {
      const got = presets.composedPreset(ctx);
      const label = typeof got === "string" ? got : got?.id || got?.name || "";
      if (label) return String(label);
    }
  } catch { /* 预设服务缺失时退回会话头 */ }
  const session = agent?.session || context?.session;
  return String(
    session?.projectionValues?.agentPreset
    || session?.agentPreset
    || session?.header?.agentPreset
    || "",
  );
}

function isSubagent(context) {
  try {
    return context?.agent?.session?.header?.origin === "subagent";
  } catch {
    return false;
  }
}

function sectionHosts(ctx) {
  const hosts = [];
  const push = (h) => { if (h && !hosts.includes(h)) hosts.push(h); };
  try { push(ctx?.systemPrompt?.ctx); } catch { /* 代理未注入 */ }
  push(ctx);
  return hosts;
}

function addSection(ctx, section) {
  const disposers = [];
  let ok = false;
  let lastError = null;
  for (const host of sectionHosts(ctx)) {
    try {
      const d = host.systemPrompt.section(section);
      ok = true;
      if (typeof d === "function") disposers.push(d);
    } catch (e) {
      const msg = String(e && e.message || e);
      if (msg.includes("already registered")) ok = true;
      else lastError = e;
    }
  }
  if (!ok && lastError) throw lastError;
  if (disposers.length && typeof ctx?.effect === "function") {
    try {
      ctx.effect(() => () => {
        for (const d of disposers.reverse()) {
          try { d(); } catch { /* ignore */ }
        }
      });
    } catch { /* 死 ctx */ }
  }
}

export function registerSections(ctx, config) {
  const cfg = cfgOf(config);
  if (!cfg.injected) return;

  addSection(ctx, {
    name: SECTIONS.CORE,
    order: Number.isFinite(cfg.order) ? cfg.order : ORDER_CORE,
    interpolate: false,
    text: (context) => {
      if (cfg.enabled === false) return "";
      const home = safeHome();
      const { text } = readPrompt(home);
      const preset = currentPreset(context);
      // 注入模式：面板里选的（state.injectMode）优先，其次看当前预设
      let mode = "complete";
      try { mode = readModeState(home).mode || "complete"; } catch { /* 读不到就按预设判 */ }
      const redteam = mode === "redteam" || isRedteamPreset(preset);
      const minimal = mode === "minimal" || isMinimalPreset(preset);
      return shapePrompt(text, { redteam, minimal });
    },
  });

  if (cfg.caps) {
    addSection(ctx, {
      name: SECTIONS.CAPS,
      order: (Number.isFinite(cfg.order) ? cfg.order : ORDER_CORE) + 1,
      interpolate: false,
      text: (context) => {
        if (cfg.enabled === false) return "";
        const redteam = isRedteamPreset(currentPreset(context));
        return capsText({
          role: redteam ? (isSubagent(context) ? "redteam-child" : "redteam") : "main",
        });
      },
    });
  }

  const tail = cfg.tailPrompt || (() => {
    try { return readModeState(safeHome()).tail || ""; } catch { return ""; }
  })();
  if (tail) {
    const order = Number(cfg.tailOrder);
    if (Number.isFinite(order) && order > (Number.isFinite(cfg.order) ? cfg.order : ORDER_CORE)) {
      addSection(ctx, {
        name: SECTIONS.TAIL,
        order,
        text: () => (cfg.enabled === false ? "" : String(tail)),
      });
    }
  }
}

function safeHome() {
  try { return findDshHome(); } catch { return ""; }
}

/* ── 工具 ─────────────────────────────────────────────────── */

const textOut = (renderText) => ({
  schema: { type: "object", additionalProperties: false, properties: { text: { type: "string" } } },
  render: (_a, v) => [{ type: "text", text: String(v?.text ?? "") }],
});

function statusText(st) {
  const c = st.counts || {};
  const head = [
    `SCRUB · ${st.surface} · ${st.ai_base || "无 aiBase"}`,
    `applied=${c.applied || 0} pending=${c.pending || 0} skipped=${c.skipped || 0} missing=${c.missing || 0} na=${c.na || 0} / ${c.total || 0}`,
    `注入稿 ${st.prompt.bytes}B ${st.prompt.customized ? "customized" : "出厂"} · ${st.prompt.path}`,
  ];
  const pending = (st.rows || []).filter((r) => r.status === "pending");
  const body = pending.slice(0, 8).map((r) => `  ✗ #${r.id} ${r.name}`);
  const tail = pending.length > 8 ? [`  … 另 ${pending.length - 8} 条`] : [];
  return [...head, ...body, ...tail, `面板 /scrub · CLI: scrub status`].join("\n");
}

function registerTools(ctx, cfg) {
  ctx.tools.register({
    name: "scrub_status",
    description: `查看宿主清洗状态（${allPatches().length} 条补丁、注入稿指纹、备份计数），面板在 /scrub。`,
    parameters: { type: "object", additionalProperties: false, properties: {} },
    output: textOut(),
    async execute() {
      const st = await gatherState();
      return { text: statusText(st) };
    },
  });

  ctx.tools.register({
    name: "scrub_apply",
    description: "把补丁打到宿主文件（提示词层 + 代码默认 + 引擎级），可选 dryRun 只看 diff 不落盘。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        ids: { type: "array", items: { type: "number" }, description: "只打指定补丁 id；省略则全量" },
        dryRun: { type: "boolean", description: "true 时只计算 diff" },
      },
    },
    output: textOut(),
    async execute(args) {
      const ids = Array.isArray(args?.ids) ? args.ids : [];
      const r = await opApply({ dshHome: findDshHome(), surface: detectSurface(), ids, dryRun: Boolean(args?.dryRun) });
      if (!r.ok) return { text: `ERROR ${r.error}` };
      const touched = r.rows.filter((x) => x.action === "written" || x.action === "would-write");
      const lines = touched.map((x) => `#${x.id} ${x.name}: ` + (x.files || [])
        .filter((f) => f.action !== "already")
        .map((f) => `${f.action} ${f.delta >= 0 ? "+" : ""}${f.delta}B`).join(", "));
      const c = r.counts || {};
      return {
        text: [
          `${r.dryRun ? "dry-run" : "apply"} · written=${r.written.length} already=${r.already} failed=${r.failed.length}`,
          `applied=${c.applied || 0} pending=${c.pending || 0} skipped=${c.skipped || 0}`,
          ...lines.slice(0, 20),
          r.dryRun ? "（未落盘；确认后 dryRun=false 再跑）" : "重启 dsh 生效",
        ].join("\n"),
      };
    },
  });

  ctx.tools.register({
    name: "scrub_revert",
    description: "从 .scrbak 备份还原被清洗的宿主文件；可只回滚指定补丁。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { ids: { type: "array", items: { type: "number" } } },
    },
    output: textOut(),
    async execute(args) {
      const ids = Array.isArray(args?.ids) ? args.ids : [];
      const r = await opRevert({ dshHome: findDshHome(), ids });
      if (!r.ok) return { text: `ERROR ${r.error}` };
      return {
        text: [
          `revert · restored=${r.restored.length} 无备份=${r.withoutBackup.length}`,
          ...r.restored.slice(0, 10).map((p) => `  ✓ ${p}`),
          "重启 dsh 生效",
        ].join("\n"),
      };
    },
  });

  ctx.tools.register({
    name: "scrub_prompt",
    description: "读写注入稿：op=get 读取；op=save 保存正文；op=preview 看整形结果；op=reseed 恢复出厂稿；op=import 从 dsh-purge 的 prompt-inject.md 迁移。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        op: { type: "string", enum: ["get", "save", "preview", "reseed", "import"] },
        text: { type: "string", description: "op=save 时的正文" },
      },
      required: ["op"],
    },
    output: textOut(),
    async execute(args) {
      const home = safeHome();
      const opName = String(args?.op || "get");
      if (opName === "get") {
        const p = readPrompt(home);
        return { text: `path=${p.path}\nbytes=${p.text.length}\n---\n${p.text.slice(0, 1200)}` };
      }
      if (opName === "save") {
        const st = savePrompt(home, String(args?.text ?? ""));
        return { text: `saved ${st.bytes}B customized=${st.customized}` };
      }
      if (opName === "preview") {
        const p = readPrompt(home);
        return { text: shapePrompt(p.text, {}).slice(0, 2000) };
      }
      if (opName === "reseed") {
        const st = reseedPrompt(home);
        return { text: `reseed ok ${st.bytes}B` };
      }
      if (opName === "import") {
        const r = importFromPurge(home);
        return { text: r.ok ? `imported ${r.bytes}B from ${r.from}` : `import failed: ${r.reason}` };
      }
      return { text: `unknown op: ${opName}` };
    },
  });

  if (cfg.verbose) {
    ctx.tools.register({
      name: "scrub_patch",
      description: "查看单条补丁的 needle / marker 与目标文件命中情况。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { id: { type: "number" } },
        required: ["id"],
      },
      output: textOut(),
      async execute(args) {
        const p = patchById(args?.id);
        if (!p) return { text: `no patch #${args?.id}` };
        const rows = await survey({ dshHome: safeHome(), surface: detectSurface(), ids: [p.id] });
        const row = rows[0];
        const files = (row?.files || []).map((f) => `${f.key} ${f.status} markers=${(f.markers || []).filter(Boolean).length}/${(f.markers || []).length} needle待打=${f.needles?.pending ?? 0}\n    ${f.path || "-"}`);
        return { text: [`#${p.id} ${p.name} (${p.layer}) ${row?.status}`, p.desc || "", ...files].join("\n") };
      },
    });
  }
}

/* ── 插件生命周期 ─────────────────────────────────────────── */

export function apply(ctx, config) {
  const cfg = cfgOf(config);

  registerSections(ctx, cfg);
  if (ctx.tools) registerTools(ctx, cfg);

  if (cfg.panel) {
    ctx.inject(["webServer"], (host) => {
      let dispose = null;
      host.effect(() => {
        dispose = registerRoutes(host.webServer, { dshHome: safeHome(), surface: detectSurface() });
        try {
          const port = host.webServer?.port;
          if (port) console.info(`[dsh-scrub] 面板 http://127.0.0.1:${port}/scrub/`);
        } catch { /* 端口不可读不影响服务 */ }
        return () => {
          if (dispose) dispose();
        };
      });
    });
  }

  if (cfg.verbose) {
    const base = pickAiBase();
    console.info(`[dsh-scrub] surface=${detectSurface()} aiBase=${base || "-"} prompt=${promptPath(safeHome())}`);
  }
}

export { allPatches, tally, gatherState };
