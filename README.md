<p align="center">
  <img src="https://raw.githubusercontent.com/yonggezx/fuling-shijie-website/main/images/logo-pink.png" width="110" alt="浮灵饰界 logo">
</p>

<h1 align="center">浮灵饰界 · 更新包仓库</h1>

<p align="center">
  桌面宠物「灵汐」的更新包与旧版站点静态页存放分支 · 应用源码见 <a href="https://github.com/yonggezx/fuling-shijie-update/tree/master">master 分支</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.12-blue" alt="version">
  <img src="https://img.shields.io/badge/branch-gh--pages-lightgrey" alt="branch">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="license">
</p>

---

## 📑 目录

- [🗂️ 分支说明](#️-分支说明)
- [📦 更新包结构](#-更新包结构)
- [🌐 站点](#-站点)
- [🔗 相关链接](#-相关链接)
- [📜 许可证](#-许可证)

---

## 🗂️ 分支说明

| 分支 | 用途 |
| --- | --- |
| `main`（默认） | 更新包与增量补丁存放区，同时是仓库展示主页 |
| `master` | 完整应用源码、构建脚本、CI 发布流水线与技术文档 |
| **`gh-pages`**（本分支） | 早期官网静态页与 `update/`、`patches/` 更新清单，由 GitHub Pages 提供访问 |

> 官网已迁移至独立仓库：[fuling-shijie-website](https://github.com/yonggezx/fuling-shijie-website) → <https://yonggezx.github.io/fuling-shijie-website/>

---

## 📦 更新包结构

```
.
├── index.html          # 旧版官网页面（品牌已更新为「浮灵饰界」）
├── images/             # 站点截图与图标
├── update/
│   ├── latest.json     # 稳定通道更新清单
│   ├── beta.json       # 测试通道更新清单
│   └── full-install.json
└── patches/            # 增量补丁包
```

安装包请前往 [Releases](https://github.com/yonggezx/fuling-shijie-update/releases/latest) 下载，产物命名规则：`FulingShijie-Setup-v{版本}.exe` / `FulingShijie-v{版本}-{arch}.dmg` / `FulingShijie-v{版本}.AppImage`。

---

## 🌐 站点

- 旧版站点：<https://yonggezx.github.io/fuling-shijie-update/>
- 当前官网：<https://yonggezx.github.io/fuling-shijie-website/>

---

## 🔗 相关链接

- 产品主页（默认分支）：[fuling-shijie-update](https://github.com/yonggezx/fuling-shijie-update)
- 源码分支：[`master`](https://github.com/yonggezx/fuling-shijie-update/tree/master)
- 官网仓库：[fuling-shijie-website](https://github.com/yonggezx/fuling-shijie-website)
- 问题反馈：[Issues](https://github.com/yonggezx/fuling-shijie-update/issues)

---

## 📜 许可证

本项目基于 [MIT 许可证](https://github.com/yonggezx/fuling-shijie-update/blob/master/LICENSE) 开源，© 2026 浮灵饰界。
