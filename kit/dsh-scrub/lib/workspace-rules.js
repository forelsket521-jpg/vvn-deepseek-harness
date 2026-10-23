// dsh-scrub · 工作区规则（AGENTS.md / CLAUDE.md 的托管段落）
// 与 dsh-purge 的 rules.js 等价的最小实现：只维护一段带标记的正文，其它内容一律不动。
//   <!-- scrub:rules:begin -->
//   ...
//   <!-- scrub:rules:end -->

import fs from "node:fs";
import path from "node:path";
import { findDshHome } from "./locate.js";

export const RULE_TARGETS = ["AGENTS.md", "CLAUDE.md"];
const BEGIN = "<!-- scrub:rules:begin -->";
const END = "<!-- scrub:rules:end -->";
const BAK = ".scrub-rule.bak";

export function ruleScopes(dshHome = findDshHome(), workspace = process.cwd()) {
  return [
    { id: "global", label: "全局（$DSH_HOME）", dir: dshHome },
    { id: "workspace", label: "当前工作区", dir: workspace },
  ];
}

export function rulePath({ scope = "global", target = "AGENTS.md", dshHome = findDshHome(), workspace = process.cwd() } = {}) {
  if (!RULE_TARGETS.includes(target)) return null;
  const base = scope === "workspace" ? workspace : dshHome;
  return path.join(base, target);
}

function read(fp) {
  try { return fs.readFileSync(fp, "utf8"); } catch { return null; }
}

export function extractBlock(text) {
  if (!text) return { has: false, body: "", before: "", after: "" };
  const i = text.indexOf(BEGIN);
  if (i < 0) return { has: false, body: "", before: text, after: "" };
  const j = text.indexOf(END, i + BEGIN.length);
  if (j < 0) return { has: false, body: "", before: text, after: "", unterminated: true };
  return {
    has: true,
    body: text.slice(i + BEGIN.length, j).replace(/^\n/, "").replace(/\n$/, ""),
    before: text.slice(0, i),
    after: text.slice(j + END.length).replace(/^\n/, ""),
  };
}

export function readRuleFile({ scope, target, dshHome, workspace } = {}) {
  const fp = rulePath({ scope, target, dshHome, workspace });
  if (!fp) return { ok: false, reason: "不支持的目标文件" };
  const text = read(fp);
  const parsed = extractBlock(text || "");
  return {
    ok: true,
    path: fp,
    exists: text !== null,
    bytes: text ? text.length : 0,
    has_block: parsed.has,
    unterminated: Boolean(parsed.unterminated),
    block: parsed.body,
    other_bytes: text ? text.length - (parsed.has ? parsed.body.length : 0) : 0,
    has_backup: fs.existsSync(fp + BAK),
  };
}

export function saveRuleFile({ scope, target, text, dshHome, workspace } = {}) {
  const fp = rulePath({ scope, target, dshHome, workspace });
  if (!fp) return { ok: false, reason: "不支持的目标文件" };
  const before = read(fp);
  const prev = extractBlock(before || "");
  const block = `${BEGIN}\n${String(text ?? "").replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "")}\n${END}`;

  let next;
  if (prev.has) {
    next = `${prev.before}${block}${prev.after ? "\n" + prev.after.replace(/^\n+/, "") : "\n"}`;
  } else {
    const base = (before || "").replace(/\s+$/, "");
    next = `${base ? base + "\n\n" : ""}${block}\n`;
  }
  if (before !== null && !fs.existsSync(fp + BAK)) fs.writeFileSync(fp + BAK, before, "utf8");
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const tmp = `${fp}.${process.pid}.${Date.now()}.scrubtmp`;
  fs.writeFileSync(tmp, next, "utf8");
  fs.renameSync(tmp, fp);
  const check = extractBlock(next);
  if (!check.has || check.body.replace(/\s+/g, " ").trim() !== String(text ?? "").replace(/\s+/g, " ").trim()) {
    return { ok: false, reason: "写入后回读不一致" };
  }
  return { ok: true, path: fp, bytes: next.length, created: before === null };
}

export function removeRuleBlock({ scope, target, dshHome, workspace } = {}) {
  const fp = rulePath({ scope, target, dshHome, workspace });
  if (!fp) return { ok: false, reason: "不支持的目标文件" };
  const before = read(fp);
  if (before === null) return { ok: false, reason: "文件不存在" };
  const parsed = extractBlock(before);
  if (!parsed.has) return { ok: false, reason: "没有托管段" };
  const next = `${parsed.before}${parsed.after}`.replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n";
  if (!fs.existsSync(fp + BAK)) fs.writeFileSync(fp + BAK, before, "utf8");
  fs.writeFileSync(fp, next, "utf8");
  return { ok: true, path: fp };
}

export function restoreRuleFile({ scope, target, dshHome, workspace } = {}) {
  const fp = rulePath({ scope, target, dshHome, workspace });
  if (!fp) return { ok: false, reason: "不支持的目标文件" };
  if (!fs.existsSync(fp + BAK)) return { ok: false, reason: "没有备份" };
  const text = fs.readFileSync(fp + BAK, "utf8");
  fs.writeFileSync(fp, text, "utf8");
  return { ok: true, path: fp, bytes: text.length };
}

export { BEGIN, END, BAK };
