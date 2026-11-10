# 🦊 浮灵饰界 · 智能桌面宠物助手

> 一个常驻桌面的 AI 伙伴：以虚拟角色「灵汐」为核心，融合 Live2D / MMD 形象、本地与云端大模型、系统级操作能力，让桌面宠物不只是装饰，而是真能帮你做事的 AI 助手。

![version](https://img.shields.io/badge/version-1.0.12-blue)

![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)

![electron](https://img.shields.io/badge/Electron-28-47848F?logo=electron&logoColor=white)

![license](https://img.shields.io/badge/license-MIT-green)

---

## 📑 目录

- [🚀 立即下载](#-立即下载)
- [✨ 功能特性](#-功能特性)
- [📸 截图](#-截图)
- [🗂️ 仓库结构说明](#️-仓库结构说明)
- [🔗 相关链接](#-相关链接)
- [📜 许可证](#-许可证)

---

## 🚀 立即下载

| 平台 | 安装包 | 体积 |
| --- | --- | --- |
| Windows 10 / 11（x64） | [`FulingShijie-Setup-v1.0.12.exe`](https://github.com/yonggezx/fuling-shijie-update/releases/latest/download/FulingShijie-Setup-v1.0.12.exe) | 约 105 MB |
| macOS（Intel） | [`FulingShijie-v1.0.12-x64.dmg`](https://github.com/yonggezx/fuling-shijie-update/releases/latest/download/FulingShijie-v1.0.12-x64.dmg) | 约 142 MB |
| macOS（Apple Silicon） | [`FulingShijie-v1.0.12-arm64.dmg`](https://github.com/yonggezx/fuling-shijie-update/releases/latest/download/FulingShijie-v1.0.12-arm64.dmg) | 约 137 MB |
| Linux（x64） | [`FulingShijie-v1.0.12.AppImage`](https://github.com/yonggezx/fuling-shijie-update/releases/latest/download/FulingShijie-v1.0.12.AppImage) / [`.deb`](https://github.com/yonggezx/fuling-shijie-update/releases/latest/download/FulingShijie-v1.0.12.deb) | 约 162 MB / 101 MB |

> 🌐 官网：[yonggezx.github.io/fuling-shijie-website](https://yonggezx.github.io/fuling-shijie-website/) · 📦 全部历史版本：[Releases](https://github.com/yonggezx/fuling-shijie-update/releases)

---

## ✨ 功能特性

- **🦊 桌面常驻宠物**：Live2D / MMD 双引擎实时渲染，呼吸、眨眼、鼠标跟随、点击互动；置顶透明窗口，可拖拽，支持自定义模型导入与皮肤热加载。
- **🤖 AI 对话助手**：兼容 OpenAI 协议的多提供商切换，也支持本地模型离线推理；上下文记忆、角色设定、多轮对话，流式输出 + Markdown 渲染。
- **⚙️ 系统级操作**：文件浏览 / 复制 / 移动 / 删除、自然语言触发系统命令、常用工具安装检测，权限可控。
- **📋 效率工具**：待办管理、本地记忆存储、模型管理器、项目面板；全局快捷键随时唤起。
- **🔄 自动更新**：electron-updater 增量补丁与完整包更新，公告弹窗、进度实时显示、断点续传。
- **🎨 任务栏集成**：Windows 任务栏注入，宠物与开始菜单 / 飞行面板视觉融合。

---

## 📸 截图

| 主界面 | AI 对话 |
| :---: | :---: |
| ![主界面](https://raw.githubusercontent.com/yonggezx/fuling-shijie-website/main/images/main-window.png) | ![AI 对话](https://raw.githubusercontent.com/yonggezx/fuling-shijie-website/main/images/ai-chat.png) |

| 宠物窗口 | 设置中心 |
| :---: | :---: |
| ![宠物窗口](https://raw.githubusercontent.com/yonggezx/fuling-shijie-website/main/images/pet-window.png) | ![设置中心](https://raw.githubusercontent.com/yonggezx/fuling-shijie-website/main/images/settings.png) |

---

## 🗂️ 仓库结构说明

| 分支 | 用途 |
| --- | --- |
| **`main`**（默认） | 更新包与增量补丁存放区（`update/`、`patches/`），不含源码 |
| `master` | 完整应用源码、构建脚本、CI 发布流水线与文档 |
| `gh-pages` | 早期站点静态文件，现已由 [官网仓库](https://github.com/yonggezx/fuling-shijie-website) 取代 |

需要源码、编译说明与技术栈细节，请切换到 [`master` 分支](https://github.com/yonggezx/fuling-shijie-update/tree/master) 查看。

---

## 🔗 相关链接

- 🌐 官网：<https://yonggezx.github.io/fuling-shijie-website/>
- 📦 版本发布：<https://github.com/yonggezx/fuling-shijie-update/releases>
- 🐛 问题反馈：[Issues](https://github.com/yonggezx/fuling-shijie-update/issues)
- 💻 源码分支：[`master`](https://github.com/yonggezx/fuling-shijie-update/tree/master)
- 🖼️ 官网仓库：[fuling-shijie-website](https://github.com/yonggezx/fuling-shijie-website)

---

## 📜 许可证

本项目基于 [MIT 许可证](https://github.com/yonggezx/fuling-shijie-update/blob/master/LICENSE) 开源。

Copyright © 2026 浮灵饰界
