# 对 dsh-purge 的三处代码修复

目标包：`dsh-purge@1.1.71`（`~/.dsh/profiles/desktop/node_modules/dsh-purge`）
方式：源码级补丁（幂等脚本 `dsh-scrub/tools/apply-purge-fixes.mjs`，升级重装后重跑即可）
备份：`lib/core.js.scrub-fix.bak`、`bin/dsh-purge.js.scrub-fix.bak`，另有 `re/core.v1.bak.js` 全量副本

---

## FIX-1 用户改稿被静默覆盖（真 bug，实测复现）

**现象**

```
POST /dsh-purge/override {"content": "<改过的稿>"}
→ HTTP 200 ok=true，回读 5109 字符（含改动）
→ 3 秒后磁盘：21194 字符（原稿）
```

**根因** `lib/core.js` 的 `looksLikePluginDefault()`

```js
const PLUGIN_DEFAULT_MARKS = ["<|im_start|>system:", "<project_instructions>", "Little Code Sauce"];
return PLUGIN_DEFAULT_MARKS.every((mark) => n.includes(mark));   // 三个标记都在 → 认定"插件默认"
```

任何**保留身份标记**的改稿都会被判成"旧默认"，随后 `syncPromptInjectOnDiskSync()` 走 `refresh_default` 分支原子写覆盖。用户视角是"保存成功但没生效"。

**改法**

- 判据改为优先读 `override-state.json` 的 `hash` / `seedHash`（`overrideTextIsOurs`）：对得上才是"我们写的默认"，对不上就是用户稿。
- 只有**完全没有 state**（首次运行）才退回文本标记，且只检查前 400 字符，避免正文里出现身份名就误判。
- 三个调用点补传 `dshHome`（`isKeepableUserOverride` / `installOverride`）。

**验证**：6 项，含"旧判据会误判 / 新判据不误判 / 改稿被保留 / 与 bundled 相同判 current / 旧版默认可刷新 / 外部改动不覆盖"。

---

## FIX-2 部分命中从"不可见"变成"可见 + 可选严格模式"

**背景**：`#47`（1/2）、`#57`（1/6）在 0.2.0 打包产物上 needle 已漂移，apply 只写命中的那几条，文件进入"一半新一半旧"状态，而状态页只要 marker 出现就显示 `applied`。

**一个必须记录的判断修正**

我原本的计划是"部分命中一律拒写"。**实测后否掉了**：`replacements` 数组同时承担两种语义——

- **升级链**：多条 needle 是同一处代码的互斥历史写法，命中一条就正确（`#1` 有 6 条变体、`#42` 有 12 条历史版本）；
- **多处替换**：多条 needle 该全部命中（`#57` 的 3 组赋值）。

数据里没有分组信息，`hit < total` 无法区分两者。一刀切会**误伤升级链**（`#42` 只命中 4/12 是正常状态）。

**改法**

- 默认：只统计 `partial` 计数并写进 report（`partial` / `partial_blocked` 两个字段），照常写入。
- 严格模式：`applyPatches(..., { blockPartial: true })` 时整条跳过，状态记 `partial_blocked`。
- `rollupPatchStatus` 增加 `partial` 参数（仅严格模式下累加，避免污染既有状态）。

**验证**：默认写入 + 报告；严格模式拒写 + 文件不变；计数进入 `partial_blocked`。

---

## FIX-3 只读诊断：把"打不动"和"还没打"分开

新增 `core.partialReport(aiBase)`，返回所有 `0 < hit < total` 的补丁；`bin/dsh-purge.js --status` 底部直接列出。

**当前真机输出**（5 条）：

```
⚠ 部分命中（needle 需按当前宿主版本更新；严格模式 blockPartial 会拒写）:
  [#30] HOOKS_CLAUDE_DENY_ALLOW              1/2   dsh-hooks-claude-code/lib/index.js
  [#40] COMPLETE_PROMPT_KEEP_INJECT          1/6   dsh-system-prompt/lib/index.js
  [#42] SETTINGS_LEGACY_API                  4/12  dsh-settings/lib/index.js
  [#47] ANTHROPIC_OAUTH_NO_CLAUDE_IDENTITY   1/2   pi-ai/dist/api/anthropic-messages.js
  [#57] DEEPSEEK_SYSTEM_ROLE                 1/6   pi-ai/dist/api/openai-completions.js
```

这 5 条此前在状态页全部显示 `applied`（`#30/#40/#42`）或 `pending`（`#47/#57`），用户无法区分"打完了"和"只打了一部分"。

---

## 验证汇总

```bash
node dsh-scrub/tools/purge-fix-test.mjs     # 16/16
node dsh-scrub/tools/apply-purge-fixes.mjs --dry   # 11/11 已存在（幂等）
node <purge>/bin/dsh-purge.js --status     # 70/82 applied，底部列 5 条部分命中
```

真机状态未受任何影响：`applied=70 pending=6 skipped=3 missing=1 na=2`。

## 回滚

```powershell
$lib = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-purge"
Copy-Item "$lib\lib\core.js.scrub-fix.bak"      "$lib\lib\core.js" -Force
Copy-Item "$lib\bin\dsh-purge.js.scrub-fix.bak" "$lib\bin\dsh-purge.js" -Force
```

（若已打过补丁脚本，`*.scrub-fix.bak` 是"打补丁前"的原文，可反复还原后重打。）

## 还没做（按优先级）

1. **文件级备份**：桌面端 `.dshpurge.bak` 数量为 0，回滚只靠 `resources/app.asar.bak` 单点；需先定位 `backupAll` 为何未产出。
2. **bak 版本指纹**：`{宿主版本, sha256}`，避免升级后 revert 把新文件换成旧内容。
3. **失效告警**：启动检测 marker 丢失 → 横幅提示，而不是静默退化。
4. **计数口径**：UI 68（折叠 9 组）与 CLI/API 82 不一致。
5. **needle 分组元数据**：给 `replacements` 加 `group`（互斥变体 / 多处替换），才能安全启用默认拒写。

---

## FIX-4 文件级备份（快照）

**问题**：桌面端 `.dshpurge.bak` 实测 0 个（`backupAll` 的 wx 占位 + `dropStale…` 清理链在这条路径上没产出），回滚只依赖 `resources/app.asar.bak` 单文件，官方更新覆盖即失效。

**做法**：新增 `lib/snapshot.js`

- `createSnapshot({targets, dshHome, label})`：把每个目标文件复制到 `$DSH_HOME/dsh-purge/snapshots/<ts>-<label>/files/`，写 `manifest.json`（绝对路径 + 相对路径 + bytes + sha256），默认保留 6 份。
- `listSnapshots` / `restoreSnapshot({id, force})`：还原前校验 sha256，不一致就跳过（防止用到被篡改的快照文件）。
- `applyPatchesAllHosts` 在 `backupAll` 之前自动拍一份 `pre-apply` 快照；`options.snapshot === false` 可关闭；快照失败不阻断 apply。
- CLI：`--snapshot` / `--snapshots` / `--restore <id>`。

**实测**：59 个文件 / 3.0 MB；还原字节一致；篡改快照后 restore 拒绝（"sha256 不一致"）。

## FIX-5 备份指纹

快照 manifest 的 `sha256` 就是内容指纹：还原前逐文件比对，避免"拿旧快照盖新文件"而不自知。`--restore` 会打印 skipped 原因。

## FIX-6 清洗失效告警

- `applyPatchesAllHosts` 成功后写 `$DSH_HOME/dsh-purge/apply-state.json`（applied / pending / aiBase / 时间）。
- `cleaningAlert({applied, last})`：掉到 0 → error；低于基线 60% → warn；轻微波动不报。
- `gatherState()` 返回 `alert`，`--status` 与 `/dsh-purge/status` 都会带出来（面板可读同名字段）。

## FIX-7 计数口径

- CLI：`补丁 70/82 已清洗（面板折叠展示 68 行）` —— 82 是真实条数，68 是 `PATCH_DISPLAY_GROUPS` 折叠后的展示行数。
- `/dsh-purge/status` 新增 `patches_total_all: 82`，与 `patches_total`（折叠口径）并存，前端想用哪个用哪个。

## FIX-8 needle 分组

- `needleGroupIndex(patch)`：按 pattern 首行标识符聚类（关键字如 `if/return/const` 不作为 key），互斥历史写法归同组；特例用 `NEEDLE_GROUP_OVERRIDES`（目前只有 #40）。
- `groupStats()`：组内 **0 命中**才算清干净（命中 = 旧文本还在）。
- `partialReport()` 分两类：
  - `half_write`：marker 已落但仍有组没清（状态页却显示 applied）；
  - `stale_needle`：未 applied 且只命中一部分（打下去必然半写）。
- `blockPartial: true` 只拦 `stale_needle`（`half_write` 已经发生，拦无意义）。

**真机结果**：半写 3 条（#30 1/2 缺1/2、#40 1/6 缺1/1、#42 4/12 缺4/10）；漂移 2 条（#47 1/2、#57 1/6）。

---

## 恢复方式（升级/重装后）

两个选择，任选其一：

**A. 整份覆盖（推荐，快）**

```powershell
$lib = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-purge"
Copy-Item re\core.v2.js            "$lib\lib\core.js" -Force
Copy-Item re\snapshot.v1.js        "$lib\lib\snapshot.js" -Force
Copy-Item re\bin-dsh-purge.v2.js   "$lib\bin\dsh-purge.js" -Force
```

**B. 文本补丁（上游升版后想保留自己的改动时）**

```powershell
node dsh-scrub\tools\apply-purge-fixes.mjs --dry   # 先看哪些能对上
node dsh-scrub\tools\apply-purge-fixes.mjs
```

B 只覆盖 FIX-1/2/3（core.js + bin 的文本替换）；FIX-4..8 依赖 `lib/snapshot.js` 与整段新增逻辑，用 A 恢复。

## 验证

```bash
node dsh-scrub/tools/purge-fix-test.mjs   # 27/27
node <purge>/bin/dsh-purge.js --status    # 半写/漂移分类 + 快照列表 + 告警
```

覆盖：用户稿判据 6 项、部分命中 5 项、分组 3 项、快照 4 项（含篡改拒绝）、告警 4 项、真机状态不变。
