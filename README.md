# vvn

**DeepSeek Harness 破甲工具。** 解锁审批 / 沙箱 / 提权限制，解除身份与拒答约束，注入自定义提示词。

82 条补丁，带图形界面，双击即用 —— 不用命令行、不用装插件、不用联网。

## 这个仓库里有别人的代码，请先看这里

`kit/plugins/vvn` 是从 **dsh-purge** 改来的：

| | |
|---|---|
| 原名 | dsh-purge |
| 作者 | 小杨 |
| 协议 | MIT |
| 地址 | https://github.com/YuJunZhiXue/dsh-purge |

**105 个文件里，69 个是原样保留的上游代码**，33 个我改过，3 个我新增。

上游版权声明在 `kit/plugins/vvn/ATTRIBUTION.md` 和 `LICENSE`，
按 MIT 协议的要求保留，未做修改。

---

## 破甲能力

82 条补丁，覆盖 DeepSeek Harness 的七类限制：

| 维度 | 打破的限制 | 补丁数 |
|---|---|---|
| **审批** | 审批弹窗、默认拒绝、拒绝话术 | #10 #11 #12 #35 |
| **沙箱** | 文件栅栏、沙箱提示、观察策略 | #15 #16 #17 #34 |
| **提权** | 提权豁免、无条件授权、升级 schema | #13 #14 #36 |
| **工具** | 命令超时、读权限上限、子代理深度、删除/移动拦截 | #21 #22 #23 #24 #48 |
| **身份** | 宿主身份、人格前缀、来源标识、Anthropic OAuth 身份 | #25 #26 #32 #43 #47 #49 |
| **宿主规则** | hooks 的 deny → allow | #30 #31 |
| **提示词** | 拒答框架、禁止句、交付约束、系统提示词重写 | #50 #53 #54 #55 |

清完的宿主里：

```
补丁 78/82 已清洗 · 0 待清洗
```

（剩下 4 条是 `不适用` 和 `缺文件` —— 本机 dsh 版本没有对应结构，不是失败。）

---

## 快速开始

前提：这台电脑装好了 DeepSeek Harness，并且启动过至少一次。

1. 解压 `vvn-v*.zip` 到固定位置（比如 `D:\vvn`）
2. 双击 `setup.cmd` —— 建桌面快捷方式
3. 双击桌面上的 vvn 图标
4. 点蓝色「一键全套」
5. 弹窗问要不要重启 dsh → 点「是」

完成。

---

## 一键全套做什么

点「一键全套」会自动：

1. 找到 DeepSeek Harness 装在哪
2. 检查插件在不在，不在就自动装上（vvn 自带插件，不联网）
3. 清洗 dsh 宿主文件（改之前自动拍快照）
4. 注入提示词
5. 问你要不要重启 dsh

---

## 为什么不需要手动装插件

`dsh-purge`（现在的 `vvn`）不在 npm 源里，只能从 GitHub 装，
而目标电脑不一定有 git、不一定能连上 GitHub。

好在它本体零依赖、只有 3.5 MB，所以直接打包带过来，
拷贝进 dsh 的 profile 目录就行 —— **不需要联网、不需要 git、不需要 npm**。

打开 vvn 的时候会自动检查并安装。

---

## 跨机器能用的设计

- 不写死盘符和目录名
- 靠注册表卸载记录的 `InstallLocation` 定位
- 找不到就全盘搜索（按 dsh 的特征文件找，不是按目录名）
- 实测翻遍 4 个盘、5800 多个目录，1-5 秒出结果

---

## 目录结构

```
vvn\
├── 先看这个.txt         新手先看这个
├── 报毒怎么办.txt       被杀毒软件拦了看这个
├── manual.txt           完整说明
├── setup.cmd            建桌面图标（新电脑跑一次）
├── vvn.exe              主程序（C# WinForms，自带图标）
├── vvn-restore.mjs      快照读取 / 还原
├── vvn-launcher.cmd     终端菜单
├── dsh-locate.cmd       查 dsh 装在哪
├── dsh-restore.cmd      命令行还原
├── dsh-install.cmd      命令行装插件
└── kit\
    ├── plugins\vvn\     插件本体（含上游代码，见 ATTRIBUTION.md）
    ├── dsh-scrub\       面板与清洗引擎
    └── dsh-purge-patches\  对上游缺陷的修复
```

---

## 关于杀毒软件报毒

无签名 + 会修改其他程序的文件 + 通过压缩包传播 —— 这个组合会被
启发式引擎当成可疑程序，属于误报。

包里的 `报毒怎么办.txt` 写了原因、怎么自己验证、四大杀软加白名单的位置。

---

## 编译 vvn.exe

```
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe ^
  /target:winexe ^
  /out:vvn.exe ^
  /win32icon:vvn.ico ^
  /win32manifest:vvn.manifest ^
  /r:System.Windows.Forms.dll ^
  /r:System.Drawing.dll ^
  /r:System.Web.Extensions.dll ^
  vvn.cs vvn-version.cs
```

源码在 `kit\dsh-scrub\tools\vvn.cs`。

---

## 自检

```
vvn.exe --check            环境自检
vvn.exe --find             全盘搜索 dsh
vvn.exe --selftest         各分支验证
vvn.exe --install-plugin   手动装插件
```

---

## 协议

我自己写的部分：随便用。

上游 `dsh-purge` 的部分：MIT，保留原版权声明（见 `LICENSE` 与 `ATTRIBUTION.md`）。