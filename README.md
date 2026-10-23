# vvn

DeepSeek Harness 的清洗与提示词注入工具。带图形界面，双击就能用。

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

## 快速开始

前提：这台电脑装好了 DeepSeek Harness，并且启动过至少一次。

1. 解压 `vvn-v*.zip` 到固定位置（比如 `D:\vvn`）
2. 双击 `setup.cmd` —— 建桌面快捷方式
3. 双击桌面上的 vvn 图标
4. 点蓝色「一键全套」
5. 弹窗问要不要重启 dsh → 点「是」

完成。

---

## 它做了什么

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