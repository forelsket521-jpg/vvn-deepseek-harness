// vvn 面板前端：纯脚本、无框架、无构建（要兼容 IE 内核的内嵌窗口，不能用 ESM）。
// 四页：清洗宿主 / 注入稿 / 规则 / 预设。

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
};

const M = {
  rows: [],
  catalog: new Map(),
  view: [],
  selected: new Set(),
  filter: { layer: "", status: "", text: "" },
  model: null,
  profile: "desktop",
  presets: null,
  prompt: { text: "", health: null },
  rules: { scope: "global", target: "AGENTS.md" },
  audit: null,
  detailShown: false,
};

/* ── 通信 ─────────────────────────────────────────────── */

async function api(path, init) {
  const res = await fetch(path, init);
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { ok: false, error: text.slice(0, 300) }; }
}

const op = (body) => api("/scrub/api/op", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/* ── 通知 ─────────────────────────────────────────────── */

const logs = [];
function log(kind, msg) {
  const t = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  logs.push({ t, kind, msg });
  if (logs.length > 300) logs.shift();
  const box = $("overview-log");
  if (box) renderLog();
}

function renderLog() {
  const box = $("overview-log");
  if (!box) return;
  box.innerHTML = "";
  for (const l of logs.slice(-200)) {
    box.append(el("div", { class: "l" }, el("span", { class: "t", text: l.t }), el("span", { class: l.kind, text: l.msg })));
  }
  box.scrollTop = box.scrollHeight;
}

let toastTimer = 0;
function toast(msg, err = false) {
  const node = $("toast");
  node.textContent = msg;
  node.className = `toast${err ? " err" : ""}`;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 3000);
}

const fmt = (n) => (typeof n === "number" ? n.toLocaleString("zh-CN") : String(n ?? ""));

/* ── 验收 ─────────────────────────────────────────────── */

async function runVerify() {
  const box = $("verify-box");
  const body = $("verify-body");
  box.hidden = false;
  body.innerHTML = "<p class='muted'>检查中…（会读宿主文件与会话缓存，约 1 秒）</p>";
  const r = await api("/scrub/api/verify");
  if (!r.ok) {
    body.innerHTML = "";
    body.append(el("p", { class: "muted", text: r.error || "验收失败" }));
    return;
  }
  $("verify-verdict").textContent = r.verdict;
  body.innerHTML = "";
  for (const g of r.groups) {
    body.append(el("div", { class: "panel-hd inner", text: `${g.key}. ${g.title}` }));
    const tbl = el("table", { class: "table compact" },
      el("thead", {}, el("tr", {}, el("th", { class: "c-status", text: "结果" }), el("th", { class: "c-layer", text: "检查项" }), el("th", { text: "值" }))),
      el("tbody", {}, g.checks.map((c) => el("tr", {},
        el("td", { class: "c-status" }, el("span", { class: `st ${c.state === "通过" ? "applied" : c.state === "未过" ? "missing" : "pending"}`, text: c.state })),
        el("td", { class: "c-layer", text: c.name }),
        el("td", { class: "muted", text: String(c.value) }),
      ))));
    body.append(tbl);
  }
  const s = r.summary || {};
  body.append(el("p", { class: "hint" },
    `硬失败 ${s.fails ?? 0} 项 · 需注意 ${s.warns ?? 0} 项 · 引擎层 ${s.engineOk ? "已破" : "未破"} · 注入层 ${s.injectOk ? "已上线" : "未上线"} · 运行时 ${s.runtimeOk ? "按清洗后配置在跑" : "未见证据"}`));
  log("info", `验收：${r.verdict}`);
}

/* ── 概览 ─────────────────────────────────────────────── */

function renderMetrics(st) {
  const c = st.counts || {};
  const box = $("metrics");
  const scoreable = Math.max(1, (c.total || 0) - (c.na || 0));
  const pct = Math.round(((c.applied || 0) / scoreable) * 100);
  const items = [
    { k: "完成度", v: `${pct}%`, s: `${c.applied || 0} / ${scoreable} 条` },
    { k: "待应用", v: c.pending || 0, s: "needle 仍在，未打" },
    { k: "已跳过", v: c.skipped || 0, s: "原文对不上" },
    { k: "缺文件", v: c.missing || 0, s: "资产不存在" },
    { k: "不适用", v: c.na || 0, s: "运行面不符" },
    { k: "备份", v: st.backups || 0, s: `${st.targets || 0} 个目标文件` },
  ];
  box.innerHTML = "";
  for (const it of items) {
    box.append(el("div", { class: "metric" },
      el("div", { class: "k", text: it.k }),
      el("div", { class: "v", text: fmt(it.v) }),
      el("div", { class: "s", text: it.s })));
  }
}

function renderOverview(st) {
  renderMetrics(st);
  const pending = (st.rows || []).filter((r) => r.status === "pending");
  const box = $("overview-pending");
  box.innerHTML = "";
  if (!pending.length) {
    box.append(el("p", { class: "muted", text: "没有待应用的补丁。" }));
  } else {
    const tbl = el("table", { class: "table compact" },
      el("thead", {}, el("tr", {}, el("th", { class: "c-id", text: "编号" }), el("th", { text: "补丁" }), el("th", { class: "c-layer", text: "层级" }), el("th", { class: "c-act", text: "操作" }))),
      el("tbody", {}, pending.map((r) => el("tr", {},
        el("td", { class: "c-id", text: r.id }),
        el("td", { text: r.name }),
        el("td", { class: "c-layer", text: r.layer }),
        el("td", { class: "c-act" }, el("button", { text: "试运行", onclick: () => doApply([r.id], true) })),
      ))));
    box.append(tbl);
  }

  const cfg = $("overview-config");
  cfg.innerHTML = "";
  const rows = [
    ["运行面", st.surface || "—"],
    ["宿主根", st.ai_base || "未找到"],
    ["注入稿", `${fmt(st.prompt.bytes)} 字符 · ${st.prompt.customized ? "已自定义" : "出厂稿"}`],
    ["注入稿路径", st.prompt.path],
    ["密文槽", st.prompt.vault],
    ["状态目录", st.dsh_home],
    ["目标文件", `${st.targets} 个`],
  ];
  for (const [k, v] of rows) {
    cfg.append(el("div", { class: "k", text: k }), el("div", { class: "v", text: String(v) }));
  }
}

/* ── 清洗 ─────────────────────────────────────────────── */

function applyFilters() {
  const { layer, status, text } = M.filter;
  const q = text.trim().toLowerCase();
  M.view = M.rows.filter((r) => {
    if (layer && r.layer !== layer) return false;
    if (status && r.status !== status) return false;
    if (q) {
      const hay = `${r.id} ${r.name} ${r.desc || ""} ${r.layer}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  renderPatchTable();
}

function renderPatchTable() {
  const body = $("patch-rows");
  body.innerHTML = "";
  for (const r of M.view) {
    const tr = el("tr", { class: M.selected.has(r.id) ? "sel" : "" },
      el("td", { class: "c-check" }, el("input", {
        type: "checkbox",
        checked: M.selected.has(r.id) ? "checked" : null,
        onchange: (e) => {
          if (e.target.checked) M.selected.add(r.id); else M.selected.delete(r.id);
          tr.classList.toggle("sel", e.target.checked);
        },
      })),
      el("td", { class: "c-id", text: r.id }),
      el("td", { class: "name", text: r.name, title: r.desc || "" }),
      el("td", { class: "c-layer", text: r.layer }),
      el("td", { class: "c-status" }, el("span", { class: `st ${r.status}`, text: statusText(r.status) })),
    );
    tr.addEventListener("click", (e) => {
      if (e.target.tagName === "INPUT") return;
      showDetail(r.id);
    });
    body.append(tr);
  }
  if (!M.view.length) {
    body.append(el("tr", {}, el("td", { colspan: 5, class: "muted" }, "没有匹配的补丁。")));
  }
  $("check-all").checked = M.view.length > 0 && M.view.every((r) => M.selected.has(r.id));
  // 首次渲染自动展开第一条，避免右侧空白
  if (!M.detailShown && M.view.length) {
    M.detailShown = true;
    showDetail(M.view[0].id);
  }
}

function statusText(s) {
  return { applied: "已应用", pending: "待应用", skipped: "已跳过", missing: "缺文件", na: "不适用", unreadable: "读不了" }[s] || s;
}

async function showDetail(id) {
  const box = $("patch-detail-body");
  box.innerHTML = "<p class='muted'>载入中…</p>";
  const d = await op({ op: "patch-detail", id });
  box.innerHTML = "";
  if (!d.ok) {
    box.append(el("p", { class: "muted", text: d.error || "读取失败" }));
    return;
  }
  const p = d.patch;
  const kv = el("div", { class: "kv" },
    el("div", { class: "k", text: "编号" }), el("div", { class: "v", text: p.id }),
    el("div", { class: "k", text: "名称" }), el("div", { class: "v", text: p.name }),
    el("div", { class: "k", text: "层级" }), el("div", { class: "v", text: p.layer }),
    el("div", { class: "k", text: "说明" }), el("div", { class: "v", text: p.desc || "—" }),
    el("div", { class: "k", text: "属性" }), el("div", { class: "v", text: [p.optional ? "可选" : "必需", p.soft ? "软判定" : "marker 判定", (p.surfaces || []).join("/") || "全运行面"].join(" · ") }),
    el("div", { class: "k", text: "状态" }), el("div", { class: "v", text: statusText((d.row || {}).status) }),
  );
  box.append(kv);

  box.append(el("div", { class: "panel-hd inner", text: "目标文件" }));
  const files = (d.row && d.row.files) || [];
  if (!files.length) box.append(el("p", { class: "muted", text: "没有目标文件。" }));
  for (const f of files) {
    const hits = (f.markers || []).filter(Boolean).length;
    box.append(el("div", { class: "kv" },
      el("div", { class: "k", text: f.key }),
      el("div", { class: "v" },
        el("div", { text: f.path || "未找到" }),
        el("div", { class: "muted", text: `marker ${hits}/${(f.markers || []).length}${f.markersAny ? "（任一）" : ""} · needle 待打 ${f.needles?.pending ?? 0}/${f.needles?.total ?? 0}${f.backup ? " · 有备份" : ""}` }),
      )));
  }

  box.append(el("div", { class: "panel-hd inner", text: `Needle（${d.needles.length}）` }));
  for (const n of d.needles) {
    box.append(el("pre", { class: "out" }, el("b", { text: `#${n.i} ${n.kind}` }), "\n", n.pattern));
  }
  if (d.markers.length) {
    box.append(el("div", { class: "panel-hd inner", text: "Marker" }));
    for (const m of d.markers) box.append(el("pre", { class: "out", text: m }));
  }
}

/* ── 动作 ─────────────────────────────────────────────── */

async function doApply(ids, dryRun) {
  const label = ids && ids.length ? `#${ids.join("、#")}` : "全部";
  log("info", `${dryRun ? "试运行" : "应用"} ${label} …`);
  showBadge("warn", "正在清洗…", "别关窗口，可能要一两分钟");
  const r = await op({ op: "apply", ids: ids || [], dryRun: Boolean(dryRun) });
  if (!r.ok) {
    log("err", r.error || "应用失败");
    toast(r.error || "应用失败", true);
    showBadge("fail", "清洗失败", r.error || "请点「导出报告」把结果发出来");
    return;
  }
  let touched = 0;
  for (const row of r.rows || []) {
    for (const f of row.files || []) {
      if (f.action === "would-write") {
        touched += 1;
        log("warn", `#${row.id} 可写 ${f.delta >= 0 ? "+" : ""}${f.delta} 字节 · ${short(f.path)}`);
      } else if (f.action === "written") {
        touched += 1;
        log("ok", `#${row.id} 已写入 ${f.delta >= 0 ? "+" : ""}${f.delta} 字节 · ${short(f.path)}`);
      }
    }
  }
  const fails = r.failed || [];
  for (const f of fails) log("err", `#${f.id} ${f.error} · ${short(f.path)}`);
  log("info", `完成：变更 ${touched} 处，已是最新 ${r.already || 0} 处，失败 ${fails.length} 处${dryRun ? "（未落盘）" : ""}`);
  toast(`${dryRun ? "试运行" : "应用"}完成 · 变更 ${touched} 处`);

  // 大号徽章：一眼能看懂成功还是失败
  if (fails.length > 0) {
    showBadge("fail", "有 " + fails.length + " 条没成功", "其余已完成。点「导出报告」可把详情发出来");
  } else if (dryRun) {
    showBadge("warn", "试运行完成", `有 ${touched} 处可以写入，但没有真的改文件`);
  } else {
    showBadge("ok", "清洗成功", touched > 0
      ? `已写入 ${touched} 处。请重启 dsh 让它生效`
      : "全部已是最新，不需要改动");
  }
  await loadState();
}

/* 大号结果徽章：绿勾 / 红叉 / 黄叹号 */
function showBadge(kind, title, sub) {
  const box = $("badge");
  if (!box) return;
  const mark = kind === "ok" ? "✓" : kind === "fail" ? "✕" : "!";
  const cls = kind === "ok" ? "b-ok" : kind === "fail" ? "b-fail" : "b-warn";
  box.className = "badge " + cls;
  box.innerHTML = "";
  box.append(
    el("div", { class: "mark", text: mark }),
    el("div", { class: "txt" }, el("b", { text: title }), el("span", { text: sub || "" }))
  );
  box.hidden = false;
}

async function doRevert(ids) {
  log("info", `回滚 ${ids && ids.length ? `#${ids.join("、#")}` : "全部"} …`);
  const r = await op({ op: "revert", ids: ids || [] });
  if (!r.ok) {
    log("err", r.error || "回滚失败");
    toast(r.error || "回滚失败", true);
    return;
  }
  for (const p of r.restored || []) log("ok", `已还原 ${short(p)}`);
  if ((r.withoutBackup || []).length) log("warn", `${r.withoutBackup.length} 个文件没有备份，未还原`);
  toast(`回滚完成 · ${(r.restored || []).length} 个文件`);
  await loadState();
}

function short(p) {
  if (!p) return "";
  const s = String(p).replace(/\\/g, "/");
  const i = s.indexOf("/resources/");
  return i >= 0 ? "…" + s.slice(i) : s;
}

function selectedIds() {
  return [...M.selected];
}

/* ── 模型 ─────────────────────────────────────────────── */

const EFFORTS = ["", "low", "medium", "high", "xhigh", "max"];

function providerLabel(p) {
  return p.displayName && p.displayName !== p.id ? `${p.id}（${p.displayName}）` : p.id;
}

/* ── 注入稿 ───────────────────────────────────────────── */

function renderHealth(h) {
  const box = $("prompt-health");
  box.innerHTML = "";
  if (!h) return;
  const rows = [
    ["字符数", fmt(h.bytes)],
    ["行数", fmt(h.lines)],
    ["段落", fmt(h.paragraphs)],
    ["信封头", h.has_envelope ? "有" : "缺失"],
    ["闭合标签", h.closed ? "有" : "缺失"],
    ["整形后长度", fmt(h.shaped_bytes)],
    ["整形会改动", h.changed_by_shape ? "是" : "否"],
    ["含非法插值", h.escaped_interp ? "是（已转义）" : "否"],
  ];
  for (const [k, v] of rows) box.append(el("div", { class: "k", text: k }), el("div", { class: "v", text: String(v) }));
  if (h.problems && h.problems.length) {
    box.append(el("div", { class: "k", text: "提示" }), el("div", { class: "v" }, h.problems.join("；")));
  }
}

async function loadPrompt() {
  const r = await api("/scrub/api/prompt");
  if (!r.ok) { log("err", r.error || "注入稿读取失败"); return; }
  M.prompt = r;
  $("prompt-text").value = r.text;
  $("prompt-meta").textContent = `${r.path}`;
  renderHealth(r.health);
  log("info", `注入稿 ${r.text.length} 字符已载入`);
}

async function savePrompt() {
  const r = await op({ op: "prompt-save", text: $("prompt-text").value });
  if (!r.ok) { toast(r.error || "保存失败", true); return; }
  renderHealth(r.health);
  log("ok", `注入稿已保存 ${r.state.bytes} 字符${r.state.customized ? "（标记为自定义）" : "（与出厂稿一致）"}`);
  toast("已保存");
  await loadState();
}

async function previewPrompt() {
  const mode = $("p-mode").value;
  const r = await op({ op: "preview", text: $("prompt-text").value, mode });
  if (!r.ok) { toast(r.error || "预览失败", true); return; }
  $("prompt-preview").textContent = r.rendered;
  log("info", `按 ${mode} 预览，${r.rendered.length} 字符`);
}

/* ── 规则 ─────────────────────────────────────────────── */

async function loadRules() {
  const { scope, target } = M.rules;
  const r = await api(`/scrub/api/rules?scope=${scope}&target=${encodeURIComponent(target)}`);
  if (!r.ok) { log("err", r.reason || "规则读取失败"); return; }
  $("rules-text").value = r.block || "";
  $("rules-meta").textContent = r.path || "";
  const info = $("rules-info");
  info.innerHTML = "";
  const rows = [
    ["文件", r.path || "—"],
    ["存在", r.exists ? "是" : "否"],
    ["托管段", r.has_block ? "有" : "无"],
    ["未闭合", r.unterminated ? "是" : "否"],
    ["备份", r.has_backup ? "有" : "无"],
  ];
  for (const [k, v] of rows) info.append(el("div", { class: "k", text: k }), el("div", { class: "v", text: String(v) }));
}

async function rulesAction(kind) {
  const { scope, target } = M.rules;
  const payload = { scope, target, text: $("rules-text").value };
  const r = await op({ op: kind === "save" ? "rules-save" : kind === "remove" ? "rules-remove" : "rules-restore", ...payload });
  if (!r.ok) { log("err", r.reason || "操作失败"); toast(r.reason || "操作失败", true); return; }
  log("ok", `${kind === "save" ? "已保存段落" : kind === "remove" ? "已移除段落" : "已从备份还原"} · ${short(r.path)}`);
  toast("完成");
  await loadRules();
}

/* ── 预设 ─────────────────────────────────────────────── */

async function loadPresets() {
  const r = await api("/scrub/api/presets");
  if (!r.ok) { log("err", r.error || "预设读取失败"); return; }
  M.presets = r;
  const box = $("mode-list");
  box.innerHTML = "";
  for (const m of r.modes) {
    const node = el("div", { class: `mode${r.mode === m.id ? " on" : ""}` },
      el("b", { text: m.label }),
      el("p", { text: m.desc }));
    node.onclick = async () => {
      const w = await op({ op: "mode-set", mode: m.id });
      if (!w.ok) { toast(w.reason || "保存失败", true); return; }
      log("ok", `注入模式 → ${m.label}`);
      await loadPresets();
    };
    box.append(node);
  }

  const body = $("preset-rows");
  body.innerHTML = "";
  for (const p of r.presets) {
    const isCurrent = M.model && M.model.current && false;
    body.append(el("tr", {},
      el("td", { text: p.id }),
      el("td", { class: "muted", text: p.source === "user" ? "用户自定义" : "随包内置" }),
      el("td", { class: "c-act" }, isCurrent ? el("span", { class: "st applied", text: "当前" }) : el("button", {
        text: "设为预设", onclick: async () => {
          const w = await op({ op: "mode-set", preset: p.id });
          if (w.ok) { log("ok", `预设记为 ${p.id}（仅记录，实际切换请在宿主里选）`); toast("已记录"); }
        },
      }))));
  }
  $("tail-text").value = r.tail || "";
}

/* ── 载入 ─────────────────────────────────────────────── */

async function loadState() {
  const st = await api("/scrub/api/state");
  if (!st.ok) { log("err", st.error || "状态读取失败"); return; }
  M.rows = st.rows || [];
  M.catalog = new Map((st.catalog || []).map((p) => [p.id, p]));
  $("pill-surface").textContent = st.surface === "desktop" ? "桌面宿主" : "Web 宿主";
  $("pill-aibase").textContent = st.ai_base || "未找到 @deepseek-ai";
  $("pill-aibase").title = st.ai_base || "";
  const layers = [...new Set(M.rows.map((r) => r.layer))];
  const sel = $("f-layer");
  const keep = sel.value;
  sel.innerHTML = "<option value=''>全部层级</option>";
  for (const l of layers) sel.append(el("option", { value: l, text: l }));
  sel.value = keep || "";
  renderOverview(st);
  applyFilters();
}

/* ── 绑定 ─────────────────────────────────────────────── */

async function activateTab(name) {
  for (const b of document.querySelectorAll("#tabs button")) b.classList.toggle("active", b.dataset.tab === name);
  for (const s of document.querySelectorAll(".tab")) s.hidden = s.id !== `tab-${name}`;
  if (location.hash !== `#${name}`) history.replaceState(null, "", `#${name}`);
  if (name === "prompt" && !$("prompt-text").value) await loadPrompt();
  if (name === "rules") await loadRules();
  if (name === "presets") await loadPresets();
}

function bindTabs() {
  for (const btn of document.querySelectorAll("#tabs button")) {
    btn.onclick = () => activateTab(btn.dataset.tab);
  }
  const initial = (location.hash || "").replace("#", "");
  if (initial && document.getElementById(`tab-${initial}`)) activateTab(initial);
  // 深链直接跑验收：/scrub/#verify
  if (initial === "verify") { activateTab("overview"); runVerify(); }
}

function bindAll() {
  $("btn-refresh").onclick = async () => { await loadState(); toast("已刷新"); };
  $("btn-verify").onclick = runVerify;
  $("btn-apply-all").onclick = () => doApply([], false);
  $("btn-dry-all").onclick = () => doApply([], true);

  $("f-layer").onchange = (e) => { M.filter.layer = e.target.value; applyFilters(); };
  $("f-status").onchange = (e) => { M.filter.status = e.target.value; applyFilters(); };
  $("f-text").oninput = (e) => { M.filter.text = e.target.value; applyFilters(); };
  $("check-all").onchange = (e) => {
    if (e.target.checked) for (const r of M.view) M.selected.add(r.id);
    else for (const r of M.view) M.selected.delete(r.id);
    renderPatchTable();
  };
  $("btn-select-visible").onclick = () => {
    for (const r of M.view) M.selected.add(r.id);
    renderPatchTable();
    toast(`已选择 ${M.view.length} 条`);
  };
  $("btn-apply-sel").onclick = () => {
    const ids = selectedIds();
    if (!ids.length) { toast("先选择补丁", true); return; }
    doApply(ids, false);
  };
  $("btn-dry-sel").onclick = () => {
    const ids = selectedIds();
    if (!ids.length) { toast("先选择补丁", true); return; }
    doApply(ids, true);
  };
  // 按钮可以不在了，绑定前先确认存在，避免整段脚本因一个 null 崩掉
  const revertBtn = $("btn-revert-sel");
  if (revertBtn) revertBtn.onclick = () => {
    const ids = selectedIds();
    if (!ids.length) { toast("先选择补丁", true); return; }
    doRevert(ids);
  };
  $("btn-export").onclick = async () => {
    const r = await op({ op: "report-export" });
    if (!r.ok) { toast(r.error || "导出失败", true); return; }
    log("ok", `报告已导出 ${r.path}（${fmt(r.bytes)} 字节）`);
    toast("报告已导出");
  };


  $("btn-prompt-save").onclick = savePrompt;
  $("btn-prompt-preview").onclick = previewPrompt;
  $("btn-prompt-import").onclick = async () => {
    const r = await op({ op: "prompt-import" });
    if (!r.ok) { log("warn", r.reason || "没有可导入的文件"); toast(r.reason || "没有可导入的文件", true); return; }
    log("ok", `已导入 ${r.bytes} 字符`);
    await loadPrompt();
  };
  $("btn-prompt-reseed").onclick = async () => {
    const r = await op({ op: "prompt-reseed" });
    if (!r.ok) { toast(r.error || "恢复失败", true); return; }
    $("prompt-text").value = r.text;
    renderHealth(r.health);
    log("warn", "已恢复出厂稿");
    toast("已恢复出厂稿");
  };
  $("p-mode").onchange = previewPrompt;

  $("r-scope").onchange = (e) => { M.rules.scope = e.target.value; loadRules(); };
  $("r-target").onchange = (e) => { M.rules.target = e.target.value; loadRules(); };
  $("btn-rules-save").onclick = () => rulesAction("save");
  $("btn-rules-remove").onclick = () => rulesAction("remove");
  $("btn-rules-restore").onclick = () => rulesAction("restore");

  $("btn-tail-save").onclick = async () => {
    const r = await op({ op: "mode-set", tail: $("tail-text").value });
    if (!r.ok) { toast(r.reason || "保存失败", true); return; }
    log("ok", "尾部附加段已保存");
    toast("已保存");
  };

  // 自动清洗宿主：一次跑全部补丁。写入期间锁按钮，避免重复点。
  $("btn-auto").onclick = async () => {
    const btn = $("btn-auto");
    const hint = $("auto-hint");
    btn.disabled = true;
    hint.textContent = "正在清洗…（自动拍快照，可能需要一两分钟）";
    try {
      await doApply(null, false);
    } finally {
      btn.disabled = false;
      hint.textContent = "一键把全部补丁写入宿主，自动拍快照、自动跳过不适用的";
    }
  };
}

bindTabs();
bindAll();
log("info", "面板已就绪");
loadState().then(() => log("ok", `载入 ${M.rows.length} 条补丁`));
