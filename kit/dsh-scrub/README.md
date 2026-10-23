# dsh-scrub

DeepSeek Harness 的宿主清洗工具，**dsh-purge 的功能等价重写**，外加一套 dsh-purge 没有的**模型配置**能力。

- 清洗：同样 82 条补丁（提示词层 / 代码默认 / 引擎级），执行器、备份模型、工具名、注入段名、面板全部另写。
- 界面：**全中文**、单色克制风格、七个标签页，不再是一排卡片。
- 模型：**一键切换默认模型 / 新增通道 / 写密钥 / 连通性测试**，直接改 profile 的 patch 层。

---

## 1. 页面

| 标签 | 内容 |
|---|---|
| **概览** | 完成度、五态计数、待处理补丁（可单条试运行）、当前配置、运行日志 |
| **清洗** | 层级/状态筛选 + 搜索；勾选后批量应用、试运行、回滚；导出报告；右侧看补丁详情（needle、marker、目标文件） |
| **模型** | 当前默认模型（通道 / 模型 / 推理强度 → 一键应用）；通道列表（接口、密钥变量、模型数、密钥状态、测试、设为默认）；新增通道；写密钥；连通性测试 |
| **注入稿** | 正文编辑 + 体检（字符/行/段落、信封、闭合、整形影响、非法插值）+ 渲染预览（完整/极简/红队）+ 保存 / 导入 / 恢复出厂 |
| **规则** | 托管 AGENTS.md / CLAUDE.md 的标记段（全局或工作区），保存 / 移除 / 从备份还原，绝不改动段外内容 |
| **预设** | 注入模式（完整 / 极简 / 红队）、宿主预设清单、尾部附加段 |
| **审计** | manifest 操作流水、备份文件列表、一键清理 |

![概览](docs/tab-overview.png)
![清洗](docs/tab-patches.png)
![模型](docs/tab-models.png)
![注入稿](docs/tab-prompt.png)

---

## 2. 模型配置（一键）

改的是 profile 的 patch 层，也就是宿主启动时真正读的那份：

```
<DSH_HOME>/profiles/<profile>/cordis.patch.yml
  - id: agent-default-model      ← 一键换模型只动这三个标量
      config: { provider, model, reasoningEffort }
  - id: llm-pi-ai
      config.providers.<通道>     ← 新增通道追加在这里
        { displayName, apiKeyEnv, api, baseURL, models[] }
<DSH_HOME>/.credentials.yaml
  refs.<变量名>: <密钥>            ← 「写密钥」写这里
```

保护措施（都是实测过的）：

1. **写前备份**：`cordis.patch.yml.scrub-model.bak`、`.credentials.yaml.scrub-model.bak`，只备份第一次。
2. **写后回读自检**：解析回来对不上就拒绝落盘（`verifyPatched`），不会留下半截配置。
3. **注释与 `!!js` 原样保留**：不用 YAML 序列化整体重写，只按缩进定位改标量与插块（`lib/yaml-lite.js`），改完注释行数与改前一致。
4. **通道名校验**：只接受 providers 表里的、用过的历史值、当前值，或在补丁层用 `- id: llm-*` 声明过的通道；其它必须显式勾「允许未声明的通道名」，避免把拼错的通道名写进启动配置。
5. **模型名校验**：通道在 providers 表里时，模型必须属于该通道；不在表里的账号型通道跳过校验并给出警告。
6. **重启生效**：patch 层只在启动时应用，所以保存后页面会提示「重启 dsh 生效」——这是事实，不是提示语的客气话。

连通性测试是**真请求**：`POST {baseURL}/chat/completions`，`max_tokens=1`，15 秒超时，回显 HTTP 状态、耗时、密钥来源与错误摘要（不打印密钥）。实测例子（本机 `token` 通道）：

```
失败 · HTTP 403 · 230ms
SUBSCRIPTION_NOT_FOUND · No active subscription found for this group
```

正是这条通道当前在服务端的状态——工具只报事实，不替你判断。

---

## 3. 命令

```bash
scrub status                     # 总览
scrub apply --dry                # 只算 diff
scrub apply --id 45,82,83        # 指定补丁
scrub revert --id 45             # 逐条回滚
scrub patch 57                   # 单条明细
scrub prompt --show              # 打印注入稿
scrub prompt --import            # 从 dsh-purge 的 prompt-inject.md 迁移
scrub prompt --reseed            # 恢复出厂密文槽正文
scrub serve --port 43190         # 独立面板（命令行之外的另一种入口）
scrub vault                      # 密文槽参数
```

`DSH_SURFACE=desktop|web` 强制运行面；`DSH_APP_RESOURCES` 指定 `resources` 目录；`DSH_HOME` 改状态目录。

---

## 4. 安装

```bash
node tools/install.mjs --profile desktop          # 先看计划（dry-run）
node tools/install.mjs --profile desktop --apply  # 复制包 + 追加 insert（会备份 profile 配置）
```

重启 dsh 后：面板 `/scrub/`，工具 `scrub_status`。

`cordis.patch.yml` 默认会把 dsh-purge 的注入/面板 `disabled: true`，避免两套同时往 system prompt 塞段。想并存就删掉那几行并把 `order` 错开。

---

## 5. 验证

```bash
node tools/selftest.mjs      # 18/18  清洗链：dry-run/写盘/.scrbak/manifest/回滚字节一致
node tools/plugin-smoke.mjs  # 11/11  插件入口：段与工具注册、工具可执行
node tools/models-test.mjs   # 29/29  模型配置：解析/切换/新增/密钥/校验拒绝/连通性/规则/预设
node tools/verify.mjs        # 与 dsh-purge 实测快照对比
```

本机结果：

- 82 条补丁逐条状态对比 dsh-purge：**0 处不一致**（70 已应用 / 6 待应用 / 3 跳过 / 1 缺文件 / 2 不适用）
- 65 个资产 key 路径映射：**0 处不一致**
- dry-run 交叉验证：`#45` 两边都算出 **+2388 字节**
- 模型：真实 profile 上读出 3 个通道（deepseek / token / qwen-token-plan-cn，共 25 个模型）、当前 `deepseek-account/deepseek-flash · high`；写操作全部在临时 DSH_HOME 副本上验证，含「拒绝未声明通道」「拒绝非法模型名」「拒绝重复通道」「拒绝非法密钥变量名」
- HTTP：`/scrub/`、`/scrub/api/{state,models,presets,rules,audit,prompt,op}` 全 200，跨站 POST 403

> 实测踩坑记录：早期版本对未声明通道放行，把 `provider: no-such` 写进了真实 profile；靠 `.scrub-model.bak` 一条命令还原，随后加了上面的第 4 条校验。教训写在代码里：**改启动配置的写操作，校验必须比"能写"更严**。

---

## 6. 验收：怎么知道破甲真的成功

```bash
node bin/scrub.js verify            # 或面板右上「验收」/ /scrub/#verify
```

分五组，逐项给「通过 / 注意 / 未过」，结论只认事实：

| 组 | 查什么 | 判定依据 |
|---|---|---|
| **A 文件层** | 补丁是否落在宿主源码 | 82 条状态、引擎级四条（#7/#8/#16/#35）、注入保活四条（#1/#55/#66/#85）、审批链五条 |
| **B 注入层** | 稿子是否存在、是否被改 | 文件字符数、信封头、`</project_instructions>`、与出厂稿 hash 比对、正文特征（模式头 / PRIME DIRECTIVE / 硬性输出规则 / 规则集） |
| **C 代码断言** | 决定行为的那几行 | `escalation` 里 `[dsh-purge]` 标记数、`agent-instructions` 是否含 STRONG_INTRO、`system-prompt` 注入保活处数、`app.asar.bak` 与解包状态 |
| **D 运行时** | 宿主实际按什么配置在跑 | 扫 `session_projcache`：`approval=never` 的会话数、`danger-full-access` 的会话数、会话里出现过注入人格名的数量 |
| **E 行为层** | 模型是否真的不拒 | 脚本只给探针句，不下结论——这是概率行为，不是配置项 |

本机实测（2026-10-22）：A/B/C/D **全通过**，E 留待探针；结论行是「引擎层 + 注入层 + 运行时 三处均已生效；行为层仍需探针确认」。

反向自查（看起来像没生效）：

| 症状 | 大概率原因 |
|---|---|
| `pending` 很多、`applied` 明显少于 70 | 宿主升级后重解包，marker 全丢 → 重新 apply |
| `app.asar.bak` 不见了 | 官方更新覆盖了原始副本 → 回滚能力已丢失，先冷备 |
| 注入稿 0 字符 / 被改乱 | 文件被清空或写坏 → `prompt restore`（重落密文槽） |
| 会话里 `sandbox=read-only`、`approval=ask` | 引擎级补丁未生效或用户在 UI 里改回来了 |
| 模型开始加免责声明 / 给"合法替代方案" | 注入在，但模型没吃住（换模型、降上下文、被系统提示压制） |

## 7. 目录

```
dsh-scrub/
├─ bin/scrub.js            # CLI
├─ lib/
│  ├─ index.js             # 插件入口：scrub-core/scrub-caps 段 + 4 个工具 + 面板路由
│  ├─ engine.js            # 补丁执行器（survey / apply / revert / rewrite）
│  ├─ locate.js            # 运行面判定 + @deepseek-ai 定位 + 65 个资产 key
│  ├─ state.js             # 注入稿、状态、manifest、操作编排
│  ├─ prompt.js            # 提示词整形（信封 / 插值 / 身份 / 模式剪裁 / 能力协议）
│  ├─ vault.js + prompt.sealed.js   # 密封槽（ChaCha20-Poly1305 + brotli + 掩码）
│  ├─ yaml-lite.js         # 按缩进编辑 YAML（保留注释与 !!js）
│  ├─ models.js            # 模型切换 / 通道 / 密钥 / 连通性
│  ├─ workspace-rules.js   # AGENTS.md 托管段
│  ├─ presets.js           # 注入模式与预设清单
│  ├─ server.js            # HTTP 桥（嵌入宿主 + 独立服务共用）
│  └─ table.data.js        # 82 条补丁数据
├─ ui/                     # 面板：index.html / app.js / style.css（中文，无构建）
├─ tools/                  # gen-table / seal-prompt / verify / selftest / plugin-smoke / models-test / install
└─ docs/                   # 截图
```

---

## 8. 边界

- **桌面 asar 解包/回滚未复刻**：只在已解包的 `resources/app` 上工作；宿主仍是密封 `app.asar` 时桌面补丁会记 `不适用/缺文件`。
- **改配置要重启**：patch 层是启动时读的。运行中的会话不会立刻换模型。
- **账号型通道**（如 `deepseek-account`）不在 providers 表里，只能靠「当前值 / 历史值 / 允许未声明」三条路径写入，工具不做模型名校验。
- **死 needle 原样保留**：#47 第 1 条、#57 在 `pi-ai` 打包产物上的 5/6 条匹配不到，这两条会一直显示待应用（与 dsh-purge 表现一致）。改法：改 `lib/table.data.js` 的对应 `replacements`。
- **没有搬**：dsh-purge 的红队演练台（约 900 KB）与其 499 KB 前端 bundle。
