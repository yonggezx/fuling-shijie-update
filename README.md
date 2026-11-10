<p align="center">
  <img src="https://raw.githubusercontent.com/yonggezx/fuling-shijie-website/main/images/logo-pink.png" width="120" alt="浮灵饰界 logo">
</p>

<h1 align="center">浮灵饰界 · 智能桌面宠物助手</h1>

<p align="center">
  一个常驻桌面的 AI 伙伴：以虚拟角色「灵汐」为核心，融合 Live2D / MMD 形象、本地与云端大模型、系统级操作能力，让桌面宠物不只是装饰，而是真能帮你做事的 AI 助手。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.12-blue" alt="version">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey" alt="platform">
  <img src="https://img.shields.io/badge/Electron-28-47848F?logo=electron&logoColor=white" alt="electron">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="license">
</p>

<p align="center">
  <a href="https://yonggezx.github.io/fuling-shijie-website/">🌐 官网</a> ·
  <a href="https://github.com/yonggezx/fuling-shijie-update/releases/latest">📦 下载</a> ·
  <a href="https://github.com/yonggezx/fuling-shijie-update/issues">🐛 反馈</a>
</p>

---

## 📑 目录

- [✨ 功能特性](#-功能特性)
- [📸 截图](#-截图)
- [📦 安装](#-安装)
- [🚀 快速开始](#-快速开始)
- [🤖 AI 配置](#-ai-配置)
- [🐾 宠物交互](#-宠物交互)
- [🧩 技术栈](#-技术栈)
- [📁 项目结构](#-项目结构)
- [🛠️ 开发](#-开发)
- [🤝 贡献](#-贡献)
- [📄 开源范围说明](#-开源范围说明)
- [📜 许可证](#-许可证)
- [💖 致谢](#-致谢)

---

## ✨ 功能特性

### 🦊 桌面宠物

- **实时角色渲染**：Live2D / MMD 双引擎，呼吸、眨眼、鼠标跟随、点击互动一应俱全。
- **窗口体验**：置顶、透明背景、可拖拽移动，支持自定义模型导入与皮肤热加载。
- **状态联动**：角色情绪随对话内容与系统状态变化，不只是静态贴图。

### 🤖 AI 对话助手

- **多提供商**：兼容 OpenAI 协议，云端服务可自由切换。
- **本地推理**：集成本地 AI 引擎，离线环境也能跑本地大模型。
- **对话体验**：上下文记忆、角色设定、多轮管理，流式输出 + 打字机效果 + Markdown 渲染与代码高亮。

### ⚙️ 系统级操作

- **文件管理**：浏览、复制、移动、删除文件。
- **命令执行**：用自然语言触发系统命令，权限可控。
- **软件安装**：自动检测并安装常用工具。
- **快捷唤起**：全局快捷键与鼠标监听，随时叫出宠物面板。

### 📋 效率工具

- 待办管理（Todo）、本地记忆存储、模型管理器、项目面板一应俱全。

### 🔄 自动更新

- 基于 electron-updater 的增量补丁与完整包更新，更新公告弹窗、进度实时显示、断点续传。

### 🎨 任务栏集成

- Windows 任务栏注入，宠物与开始菜单 / 飞行面板视觉融合，适配亚克力与透明效果。

---

## 📸 截图

| 主界面 | AI 对话 |
| :---: | :---: |
| ![主界面](https://raw.githubusercontent.com/yonggezx/fuling-shijie-website/main/images/main-window.png) | ![AI 对话](https://raw.githubusercontent.com/yonggezx/fuling-shijie-website/main/images/ai-chat.png) |

| 宠物窗口 | 设置中心 |
| :---: | :---: |
| ![宠物窗口](https://raw.githubusercontent.com/yonggezx/fuling-shijie-website/main/images/pet-window.png) | ![设置中心](https://raw.githubusercontent.com/yonggezx/fuling-shijie-website/main/images/settings.png) |

> 更多界面截图见 [官网](https://yonggezx.github.io/fuling-shijie-website/)。

---

## 📦 安装

### 系统要求

| 项目 | 要求 |
| --- | --- |
| 操作系统 | Windows 10 / 11（x64），macOS 12+，Ubuntu 22.04+ |
| Node.js | ≥ 16（推荐 18+，仅源码运行需要） |
| npm | ≥ 8 |
| C++ 环境 | Visual Studio 2022 或 Build Tools + Windows SDK（仅编译任务栏注入 DLL 时需要） |

### 下载预编译包

前往 [Releases](https://github.com/yonggezx/fuling-shijie-update/releases/latest) 下载对应平台安装包，双击安装即可：

| 平台 | 安装包 |
| --- | --- |
| Windows x64 | `FulingShijie-Setup-v1.0.12.exe` |
| macOS Intel | `FulingShijie-v1.0.12-x64.dmg` |
| macOS Apple Silicon | `FulingShijie-v1.0.12-arm64.dmg` |
| Linux x64 | `FulingShijie-v1.0.12.AppImage` / `FulingShijie-v1.0.12.deb` |

### 从源码运行

```bash
git clone https://github.com/yonggezx/fuling-shijie-update.git
cd fuling-shijie-update
npm install          # 安装依赖
npm run dev          # 开发模式（含语法检查）
```

---

## 🚀 快速开始

1. 启动后宠物出现在桌面，拖拽即可移动位置。
2. 通过托盘菜单 / 全局快捷键唤起主界面，进入「AI 对话」。
3. 直接用自然语言下达指令，例如「帮我整理这个文件夹」「提醒我 3 点开会」。
4. 在「设置 → AI」中填入模型 API Key（或接入本地模型）后，全部能力解锁。
5. 需要更新时，应用内即可检查版本、下载完整包或增量补丁。

---

## 🤖 AI 配置

在「设置 → AI」中配置提供商，支持云端（OpenAI 协议兼容）与本地引擎两种模式：

| 字段 | 说明 | 默认值 |
| --- | --- | --- |
| `apiKey` | 大模型 API 密钥（本地模型可留空） | 无 |
| `baseUrl` | 自定义 API 地址（兼容 OpenAI 协议） | 官方地址 |
| `model` | 模型名，如 `gpt-4o-mini` / 本地 `gguf` 模型 | — |
| `maxTokens` | 单次回复最大 token | 按提供商 |
| `systemPrompt` | 角色「灵汐」的性格设定 | 内置人设 |
| `enableTools` | 是否允许 Agent 调用本地工具 | `true` |

> 🔒 密钥与对话记录仅保存在本地，不会上传服务器。

---

## 🐾 宠物交互

| 操作 | 效果 |
| --- | --- |
| 拖拽宠物 | 移动位置，支持贴边停靠 |
| 单击 | 随机动作 / 打招呼 |
| 双击 | 打开主界面与对话面板 |
| 右键 | 托盘菜单（设置 / 隐藏 / 退出） |
| 长时间无交互 | 进入待机动画，降低资源占用 |

---

## 🧩 技术栈

| 类别 | 技术 |
| --- | --- |
| 应用框架 | Electron 28 |
| 前端 | 原生 HTML5 / CSS3 / JavaScript（无框架） |
| 2D 渲染 | PixiJS 6 + pixi-live2d-display |
| 3D / MMD | Three.js（MMDLoader / MMDAnimationHelper） |
| 原生交互 | koffi（FFI 调用 Windows API） |
| 语音 | sherpa-onnx-node（本地语音识别） |
| 数据存储 | 本地 JSON 配置 + Supabase（可选云端同步） |
| 自动更新 | electron-updater（增量与完整包） |
| 构建打包 | electron-builder 24 |
| 任务栏注入 | C++（MinHook / Detours，需自行编译） |
| 国际化 | 中文 / 英文（`data-i18n` 方案） |

---

## 📁 项目结构

```
.
├── src/
│   ├── main/                     # 主进程
│   │   ├── main.js               # 应用入口、窗口管理
│   │   ├── configManager.js      # 配置管理
│   │   ├── taskbarTransparency.js# 任务栏透明效果
│   │   ├── ipc/                  # IPC 业务模块
│   │   │   ├── aiOps.js          # AI 对话
│   │   │   ├── localAiEngine.js  # 本地 AI 引擎
│   │   │   ├── modelManager.js   # 模型管理
│   │   │   ├── fileOps.js        # 文件操作
│   │   │   ├── commandOps.js     # 命令执行
│   │   │   ├── updateOps.js      # 更新下载与安装
│   │   │   └── ...
│   │   └── taskbar-inject/       # 任务栏注入（C++ 源码 + JS 客户端）
│   ├── renderer/                 # 渲染进程
│   │   ├── index.html            # 主界面
│   │   ├── pet.html              # 宠物窗口
│   │   └── js/                   # 界面逻辑（app / mmdPet / i18n / icons ...）
│   └── preload.js
├── scripts/                      # 构建、发布、部署与自检脚本
├── assets/                       # 图标、渲染库与品牌资源
├── .github/workflows/            # 跨平台发布流水线
├── package.json
├── LICENSE
└── README.md
```

---

## 🛠️ 开发

```bash
npm start            # 启动应用
npm run dev          # 开发模式（语法检查 + 启动）
npm run check        # 一组基础自检
npm run build:win    # 打包 Windows 安装包（dist/）
npm run build:linux  # 打包 Linux（AppImage / deb）
npm run build:mac    # 打包 macOS（dmg / zip）
```

- **代码自检**：`npm run check:agent-config`、`check:mcp`、`check:connectors`、`check:marketplace` 覆盖配置、MCP、连接器与市场模块。
- **任务栏注入 DLL**（可选）：源码位于 `src/main/taskbar-inject/`，需自行获取 MinHook / Detours 头文件后用 MSVC 编译。
- **调试技巧**：开发模式下按 `F12` 打开开发者工具；宠物窗口透明 / 点击穿透异常时，优先检查 `transparent` 与 `skipTaskbar` 配置。

---

## 🤝 贡献

欢迎 Issue 与 PR：

1. Fork 本仓库
2. 新建分支 `git checkout -b feat/你的功能`
3. 提交 `git commit -m 'feat: 新增 XX'`
4. 推送并发起 Pull Request

提交前请确保本地自检通过；新增宠物形象请附带授权说明。

---

## 📄 开源范围说明

本仓库公开的是**应用核心源码**，包括：

- ✅ 主进程与渲染进程的全部 JavaScript / HTML / CSS 源码
- ✅ 任务栏注入的 C++ 源码与 JS 通信客户端
- ✅ 构建、发布、部署脚本与 CI 流水线
- ✅ 应用图标与品牌资源
- ✅ `package.json` / `package-lock.json` / 许可证

以下内容**不包含**在本仓库中：

- ❌ 安装器与卸载器工程（installer / uninstaller）
- ❌ 第三方库完整源码（MinHook、Detours、Three.js 等，通过 npm 或自行获取）
- ❌ 调试脚本、探测脚本、测试截图
- ❌ 编译产物（DLL / EXE / 压缩包）
- ❌ 安全与激活相关模块
- ❌ 用户协议与免责声明文案

如需完整构建出可运行的安装包，需在上述缺失模块基础上自行补充。

---

## 📜 许可证

本项目基于 [MIT 许可证](LICENSE) 开源。

Copyright © 2026 浮灵饰界

---

## 💖 致谢

- 灵感来自经典桌面宠物与各类 AI 助手项目
- 感谢所有贡献者与使用者的支持
