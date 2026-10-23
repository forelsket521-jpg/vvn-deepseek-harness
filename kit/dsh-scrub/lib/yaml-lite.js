// dsh-scrub · 极简 YAML 文本编辑
// 只用在一个地方：profile 的 cordis.patch.yml（以及 .credentials.yaml 的 refs 段）。
// 为什么不用 yaml 包：那份文件里全是注释和 `!!js` 表达式，dump 一遍注释全丢、表达式会被改写成字符串。
// 这里只做「按缩进定位块 → 改标量 / 插块」，改完再做一次结构自检。

const BOM = /^\uFEFF/;

export function toLines(text) {
  return String(text ?? "").replace(BOM, "").replace(/\r\n/g, "\n").split("\n");
}

export function fromLines(lines, hadCrlf) {
  const body = lines.join("\n");
  return hadCrlf ? body.replace(/\n/g, "\r\n") : body;
}

export function hasCrlf(text) {
  return /\r\n/.test(String(text ?? ""));
}

const indentOf = (line) => (line.match(/^ */) || [""])[0].length;
const isBlank = (line) => /^\s*(#.*)?$/.test(line);

/** 顶层列表项块：`- id: X` → 到下一个顶层 `- ` 之前。 */
export function blocks(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^- id:\s*(\S+)\s*$/);
    if (!m) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^- /.test(lines[j])) { end = j; break; }
    }
    out.push({ id: m[1].replace(/^["']|["']$/g, ""), start: i, end });
  }
  return out;
}

export function findBlock(lines, id) {
  return blocks(lines).find((b) => b.id === id) || null;
}

/** 在块内按缩进向上找父级，返回 key 所在行号（找不到返回 -1）。 */
export function findKey(lines, from, to, keyPath) {
  const keys = Array.isArray(keyPath) ? keyPath : String(keyPath).split(".");
  let start = from;
  let end = to;
  let cursor = -1;
  let parentIndent = -1;
  for (const key of keys) {
    let found = -1;
    for (let i = start; i < end; i += 1) {
      const line = lines[i];
      if (isBlank(line)) continue;
      const ind = indentOf(line);
      if (parentIndent >= 0 && ind <= parentIndent) break; // 出了父级范围
      const m = line.match(/^(\s*)([A-Za-z0-9_.\-"]+):(.*)$/);
      if (!m) continue;
      if (m[2].replace(/^"|"$/g, "") !== key) continue;
      found = i;
      parentIndent = ind;
      break;
    }
    if (found < 0) return -1;
    cursor = found;
    start = found + 1;
    // 子范围：直到缩进回落到父级
    let e = end;
    for (let i = start; i < end; i += 1) {
      if (isBlank(lines[i])) continue;
      if (indentOf(lines[i]) <= parentIndent) { e = i; break; }
    }
    end = e;
  }
  return cursor;
}

export function readScalar(lines, lineIdx) {
  if (lineIdx < 0) return null;
  const m = lines[lineIdx].match(/^(\s*)([A-Za-z0-9_.\-"]+):\s*(.*)$/);
  if (!m) return null;
  let value = m[3].trim();
  if (value === "" || value === "~" || value === "null") return null;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return value;
}

/** 读一个块里点路径的标量值。 */
export function getScalar(text, blockId, keyPath) {
  const lines = toLines(text);
  const block = findBlock(lines, blockId);
  if (!block) return null;
  const idx = findKey(lines, block.start + 1, block.end, keyPath);
  return idx < 0 ? null : readScalar(lines, idx);
}

/** 写一个块里点路径的标量；不存在就在父级末尾补一行。 */
export function setScalar(text, blockId, keyPath, value) {
  const crlf = hasCrlf(text);
  const lines = toLines(text);
  const block = findBlock(lines, blockId);
  if (!block) return { text: String(text ?? ""), ok: false, reason: `找不到块 ${blockId}` };
  const idx = findKey(lines, block.start + 1, block.end, keyPath);
  const str = String(value);

  if (idx >= 0) {
    const m = lines[idx].match(/^(\s*)([A-Za-z0-9_.\-"]+):/);
    lines[idx] = `${m[1]}${m[2]}: ${str}`;
    return { text: fromLines(lines, crlf), ok: true, line: idx + 1, mode: "replace" };
  }

  // 不存在：在父级最后一行之后插入
  const keys = Array.isArray(keyPath) ? keyPath : String(keyPath).split(".");
  const parentPath = keys.slice(0, -1);
  const leaf = keys[keys.length - 1];
  const parentIdx = parentPath.length ? findKey(lines, block.start + 1, block.end, parentPath) : -1;
  if (parentIdx < 0) return { text: String(text ?? ""), ok: false, reason: `找不到父级 ${parentPath.join(".")}` };
  const parentIndent = indentOf(lines[parentIdx]);
  let insertAt = parentIdx + 1;
  for (let i = parentIdx + 1; i < block.end; i += 1) {
    if (isBlank(lines[i])) continue;
    if (indentOf(lines[i]) <= parentIndent) break;
    insertAt = i + 1;
  }
  lines.splice(insertAt, 0, `${" ".repeat(parentIndent + 2)}${leaf}: ${str}`);
  return { text: fromLines(lines, crlf), ok: true, line: insertAt + 1, mode: "insert" };
}

/* ── providers 解析（llm-pi-ai 的 config.providers） ───────── */

export function parseProviders(text, blockId = "llm-pi-ai") {
  const lines = toLines(text);
  const block = findBlock(lines, blockId);
  if (!block) return [];
  const providersIdx = findKey(lines, block.start + 1, block.end, "config.providers");
  if (providersIdx < 0) return [];
  const pIndent = indentOf(lines[providersIdx]);
  const out = [];
  let current = null;

  for (let i = providersIdx + 1; i < block.end; i += 1) {
    const line = lines[i];
    if (isBlank(line)) continue;
    const ind = indentOf(line);
    if (ind <= pIndent) break;

    const trimmed = line.trim();
    const isItem = trimmed.startsWith("- ");
    const keyIndent = isItem ? ind + 2 : ind;
    const kvText = isItem ? trimmed.slice(2) : trimmed;
    const kv = kvText.match(/^([A-Za-z0-9_.\-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const val = kv[2].trim();

    // provider 名：providers 的下一级、非列表项
    if (!isItem && ind === pIndent + 2) {
      current = { id: key, displayName: val, baseURL: "", api: "", apiKeyEnv: "", models: [] };
      out.push(current);
      continue;
    }
    if (!current) continue;

    if (!isItem && ind === pIndent + 4) {
      if (key === "baseURL") current.baseURL = val;
      else if (key === "api") current.api = val;
      else if (key === "apiKeyEnv") current.apiKeyEnv = val;
      else if (key === "displayName") current.displayName = val;
      continue;
    }
    if (isItem && keyIndent >= pIndent + 6 && key === "id") {
      current.models.push({ id: val, name: "" });
      continue;
    }
    if (!isItem && keyIndent >= pIndent + 6 && key === "name") {
      const last = current.models[current.models.length - 1];
      if (last && !last.name) last.name = val;
    }
  }
  return out;
}

/** 在 providers 映射末尾插入一个新 provider（缩进跟着现有条目走）。 */
export function addProvider(text, provider, blockId = "llm-pi-ai") {
  const crlf = hasCrlf(text);
  const lines = toLines(text);
  const block = findBlock(lines, blockId);
  if (!block) return { text: String(text ?? ""), ok: false, reason: `找不到块 ${blockId}` };
  const providersIdx = findKey(lines, block.start + 1, block.end, "config.providers");
  if (providersIdx < 0) return { text: String(text ?? ""), ok: false, reason: "该块没有 config.providers" };
  const pIndent = indentOf(lines[providersIdx]);
  let insertAt = providersIdx + 1;
  for (let i = providersIdx + 1; i < block.end; i += 1) {
    if (isBlank(lines[i])) continue;
    if (indentOf(lines[i]) <= pIndent) break;
    insertAt = i + 1;
  }

  const pad = (n) => " ".repeat(n);
  const pName = String(provider.id || "").trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(pName)) return { text: String(text ?? ""), ok: false, reason: "provider 名只能是字母数字._-" };
  const body = [];
  body.push(`${pad(pIndent + 2)}${pName}:`);
  if (provider.displayName) body.push(`${pad(pIndent + 4)}displayName: ${provider.displayName}`);
  if (provider.apiKeyEnv) body.push(`${pad(pIndent + 4)}apiKeyEnv: ${provider.apiKeyEnv}`);
  if (provider.api) body.push(`${pad(pIndent + 4)}api: ${provider.api}`);
  if (provider.baseURL) body.push(`${pad(pIndent + 4)}baseURL: ${provider.baseURL}`);
  body.push(`${pad(pIndent + 4)}models:`);
  for (const m of provider.models || []) {
    body.push(`${pad(pIndent + 6)}- id: ${m.id}`);
    if (m.name) body.push(`${pad(pIndent + 8)}name: ${m.name}`);
    if (m.contextWindow) body.push(`${pad(pIndent + 8)}contextWindow: ${m.contextWindow}`);
    if (m.maxTokens) body.push(`${pad(pIndent + 8)}maxTokens: ${m.maxTokens}`);
    if (Array.isArray(m.input) && m.input.length) {
      body.push(`${pad(pIndent + 8)}input:`);
      for (const mod of m.input) body.push(`${pad(pIndent + 10)}- ${mod}`);
    }
  }
  lines.splice(insertAt, 0, ...body);
  return { text: fromLines(lines, crlf), ok: true, inserted: body.length, line: insertAt + 1 };
}

/* ── .credentials.yaml 的 refs 段 ─────────────────────────── */

export function parseRefs(text) {
  const lines = toLines(text);
  const out = {};
  const refsIdx = lines.findIndex((l) => /^refs:\s*$/.test(l));
  if (refsIdx < 0) return out;
  for (let i = refsIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (indentOf(line) === 0) break;
    const m = line.match(/^\s+([A-Za-z0-9_.\-]+):\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

export function setRef(text, name, value) {
  const crlf = hasCrlf(text);
  const src = String(text ?? "");
  const lines = toLines(src);
  let refsIdx = lines.findIndex((l) => /^refs:\s*$/.test(l));
  if (refsIdx < 0) {
    lines.push("refs:");
    refsIdx = lines.length - 1;
  }
  let target = -1;
  for (let i = refsIdx + 1; i < lines.length; i += 1) {
    if (!lines[i].trim()) continue;
    if (indentOf(lines[i]) === 0) break;
    const m = lines[i].match(/^\s+([A-Za-z0-9_.\-]+):/);
    if (m && m[1] === name) { target = i; break; }
  }
  if (target >= 0) {
    lines[target] = `  ${name}: ${value}`;
    return { text: fromLines(lines, crlf), ok: true, mode: "replace" };
  }
  let insertAt = refsIdx + 1;
  for (let i = refsIdx + 1; i < lines.length; i += 1) {
    if (!lines[i].trim()) continue;
    if (indentOf(lines[i]) === 0) break;
    insertAt = i + 1;
  }
  lines.splice(insertAt, 0, `  ${name}: ${value}`);
  return { text: fromLines(lines, crlf), ok: true, mode: "insert" };
}

export function maskSecret(value) {
  const s = String(value ?? "");
  if (!s) return "";
  if (s.length <= 8) return "****";
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

/** 写后自检：块还在、目标键可读回、行数没塌。 */
export function verifyPatched(before, after, blockId, keyPath, expect) {
  const linesAfter = toLines(after);
  if (!findBlock(linesAfter, blockId)) return { ok: false, reason: "块丢失" };
  if (linesAfter.length < toLines(before).length - 2) return { ok: false, reason: "行数异常减少" };
  const got = getScalar(after, blockId, keyPath);
  if (String(got) !== String(expect)) return { ok: false, reason: `回读不一致：${got} ≠ ${expect}` };
  return { ok: true };
}
