# dsh-scrub 工具包

给你的 dsh 做两件事：**清洗宿主**（改掉审批/沙箱/提示词的默认行为）+ **配置模型**（一键切通道）。

---

## 四个入口（双击即可）

| 文件 | 作用 | 什么时候用 |
|---|---|---|
| `1-安装到dsh.cmd` | 把 dsh-scrub 装进 dsh | 想用面板和清洗工具时。会先预演再确认 |
| `2-查看状态.cmd` | 看补丁状态 + 跑验收 + 回归测试 | 升级 dsh 之后、怀疑失效时 |
| `3-打开面板.cmd` | 起本地面板并自动开浏览器 | 日常操作（清洗、模型、注入稿、规则） |
| `4-还原宿主文件.cmd` | 从快照还原 dsh 本体文件 | 改动出问题、想退回某次 apply 之前 |

`4-还原宿主文件.cmd` 支持三种用法：

```
双击                          → 列出快照，输入 ID 还原
4-还原宿主文件.cmd <快照ID>     → 直接还原
4-还原宿主文件.cmd <快照ID> --dry → 只报告不改文件
```

输入不存在的 ID 会中止且不动任何文件；直接回车取消。

装完重启 dsh，面板地址是 **http://127.0.0.1:19387/scrub/**（dsh 自己的端口）。

---

## dsh-scrub 面板有什么

- **概览** — 完成度、五态计数、待处理补丁、当前配置
- **清洗** — 82 条补丁，可筛层/状态/搜索、勾选批量应用、试运行、回滚、导出报告
- **模型** — 一键换默认模型（chanel/模型/推理强度）、通道列表、新增通道、写密钥、**真发请求测连通**
- **注入稿** — 编辑破甲稿、体检（信封/闭合/非法插值）、三模式预览、保存/导入/恢复出厂
- **规则** — 托管 AGENTS.md / CLAUDE.md 的标记段，段外内容不动
- **预设** — 注入模式（完整/极简/红队）、宿主预设、尾部附加段
- **审计** — 操作流水、备份文件、一键清理

全部中文，键盘可用：`/` 过滤、`j/k` 移动、`d` 试运行、`a` 全量应用、`r` 回滚、`p` 注入稿。

---

## dsh-purge-patches 是什么

dsh-purge 本体（dsh 里真正在生效的那个）的 8 处修复，源码级改过：

| 编号 | 修了什么 |
|---|---|
| FIX-1 | 用户改的注入稿被静默覆盖（判据只看三个文本标记） |
| FIX-2 | 部分命中可见 + 可选严格模式（`blockPartial`） |
| FIX-3 | 只读诊断：`partialReport()` + `--status` 列出问题补丁 |
| FIX-4 | 文件级快照（`--snapshot` / `--snapshots` / `--restore`） |
| FIX-5 | 快照带 sha256 指纹，还原前校验 |
| FIX-6 | 清洗失效告警（对比上次 apply 的基线） |
| FIX-7 | 计数口径统一（82 真值 / 68 折叠展示） |
| FIX-8 | needle 分组 + 版本适配（#73 半写修正、hooks 副作用收敛） |

`#73` 半写的成因值得单独记一笔：那条补丁的 `skipIfMarked` 为 true，早先某一次 apply 只完成了"给 pwsh 段打标记"这一步就落下了 marker；此后每次 apply 都因为 marker 命中而整条跳过，那句"你没有网络访问"就永远删不掉了。修法是给该补丁加一条"落盘判据"的追加 needle，并让 `skipIfMarked` 不阻塞这类追加动作。

文件说明：

- `core.v2.js` / `index.v2.js` / `bin-dsh-purge.v2.js` / `snapshot.v1.js` — **改完的源码**。升级 dsh-purge 后把它们覆盖回去即可恢复全部修复。
- `core.v1.bak.js` / `asset-table.v1.bak.js` — 原始版本（回滚用）。
- `apply-purge-fixes.mjs` — 文本补丁脚本（幂等，覆盖 FIX-1/2/3）。
- `purge-fix-test.mjs` — 28 项自测。

覆盖恢复：

```powershell
$lib = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-purge"
Copy-Item core.v2.js          "$lib\lib\core.js" -Force
Copy-Item index.v2.js         "$lib\lib\index.js" -Force
Copy-Item snapshot.v1.js      "$lib\lib\snapshot.js" -Force
Copy-Item bin-dsh-purge.v2.js "$lib\bin\dsh-purge.js" -Force
```

---

## docs

- `purge-fixes.md` — 八处修复的完整记录：问题、根因、改法、验证、恢复方式
- `prompt-v2.md` — 重写后的注入稿（21KB → 5KB，25 类能力面全覆盖，新增诚实性与风险边界条款）
- 面板截图若干

---

## 已知边界

- 桌面宿主上 dsh-purge 的 `.dshpurge.bak` 实测为 0，所以**原始态的唯一副本是 `C:\deepseek\resources\app.asar.bak`** —— 建议自己再冷备一份，官方更新会覆盖它。
- 官方的 `hooksDenyBypass` 当前是 `false`：**完整 apply 后** dsh-purge 会主动把 hooks 的 deny→allow 还原成官方形态。只打单条补丁时不会再误伤（这是 FIX-8 收敛掉的副作用）。
- 改配置（模型通道、注入稿）都在 profile 的 `cordis.patch.yml` / `.credentials.yaml`，**重启 dsh 才生效**。