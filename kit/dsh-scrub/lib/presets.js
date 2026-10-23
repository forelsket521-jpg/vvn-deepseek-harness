// dsh-scrub · 预设与注入模式
// 只做两件事：把宿主现有预设列出来（给面板下拉），把「注入模式」存到自己的 state。
// 注入模式影响 prompt.js 的整形：complete / minimal / redteam / custom（附加尾段）。

import fs from "node:fs";
import path from "node:path";
import { findAiBases, findDshHome } from "./locate.js";
import { readState, writeState } from "./state.js";

export const MODES = [
  { id: "complete", label: "完整", desc: "原样注入，含 CTF 契约与工具纪律" },
  { id: "minimal", label: "极简", desc: "剥掉 STRICT 工具块，只留行为约束" },
  { id: "redteam", label: "红队", desc: "剥掉 CTF 契约，走主控/执行者协议" },
];

export function listPresets(dshHome = findDshHome()) {
  const out = [];
  const seen = new Set();
  const push = (p) => {
    if (!p.id || seen.has(p.id)) return;
    seen.add(p.id);
    out.push(p);
  };

  for (const base of findAiBases({ dshHome })) {
    const dir = path.join(base, "dsh-web-app", "presets");
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith(".patch.yml"));
    } catch { /* 没有就不列 */ }
    for (const n of names) {
      push({ id: n.replace(/\.patch\.yml$/, ""), source: "shipped", path: path.join(dir, n) });
    }
    break;
  }

  const userPresets = path.join(dshHome, ".agent-presets");
  try {
    for (const e of fs.readdirSync(userPresets, { withFileTypes: true })) {
      if (e.isDirectory()) push({ id: e.name, source: "user", path: path.join(userPresets, e.name) });
    }
  } catch { /* 无自定义预设 */ }

  return out;
}

export function readModeState(dshHome = findDshHome()) {
  const st = readState(dshHome);
  return {
    mode: st.injectMode || "complete",
    tail: st.tailPrompt || "",
    preset: st.preset || "",
    modes: MODES,
  };
}

export function writeModeState({ dshHome = findDshHome(), mode, tail, preset } = {}) {
  const patch = {};
  if (mode !== undefined) {
    if (!MODES.some((m) => m.id === mode)) return { ok: false, reason: `未知模式: ${mode}` };
    patch.injectMode = mode;
  }
  if (tail !== undefined) patch.tailPrompt = String(tail || "");
  if (preset !== undefined) patch.preset = String(preset || "");
  const st = writeState(dshHome, patch);
  return { ok: true, state: { mode: st.injectMode, tail: st.tailPrompt, preset: st.preset } };
}

/** 面板用的预设快照。 */
export function presetsSnapshot(dshHome = findDshHome()) {
  const mode = readModeState(dshHome);
  return {
    presets: listPresets(dshHome),
    mode: mode.mode,
    modes: mode.modes,
    tail: mode.tail,
    preset: mode.preset,
  };
}
