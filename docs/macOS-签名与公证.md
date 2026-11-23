# macOS 打包：品牌化 dmg + 签名 / 公证

## 1. 产物与素材

| 文件 | 用途 |
| --- | --- |
| `assets/dmg/background.png`（620×400） | dmg 窗口背景；分辨率即窗口尺寸 |
| `assets/dmg/background@2x.png`（1240×800） | Retina 背景，由 dmg-builder 自动 `tiffutil` 合成 tiff |
| `assets/icons/icon.icns` | 应用与 dmg 卷图标（含 128/256/512/1024 四档） |
| `assets/icons/icon-1024.png` | icns 的 1024 母版，也用于商店/文档 |

重新生成（改了 logo 或配色后执行）：

```bash
npm run gen:mac-assets
```

脚本 `scripts/gen-mac-assets.js` 用 Electron 离屏 Canvas 绘制，产物直接提交仓库，CI 不再跑生成。

## 2. dmg 布局

`package.json` 的 `build.dmg`：

- 窗口 620×400，背景为品牌粉渐变 + 顶部标题 + 两个虚线落位圈 + 中间箭头；
- 应用图标落位 `(160, 200)`，`/Applications` 快捷方式 `(460, 200)`，图标 96px；
- `sign: false`：不对 dmg 外壳签名（外壳签名与公证组合容易触发 Gatekeeper 报错），内部 app 仍然签名并公证。

## 3. 签名

`build.mac` 已开启：

```json
"hardenedRuntime": true,
"gatekeeperAssess": false,
"entitlements": "assets/entitlements.mac.plist",
"entitlementsInherit": "assets/entitlements.mac.plist"
```

`identity` 不再写死 `null`：electron-builder 会从 `CSC_LINK` 导入的证书或本机钥匙串里自动挑选 Developer ID Application 证书。

entitlements 只放开 Electron 必需的三项：`allow-jit`、`allow-unsigned-executable-memory`、`disable-library-validation`（后者用于 sherpa-onnx / koffi 等原生模块与 asarUnpack 里的二进制）。

## 4. 公证

`build.afterSign` → `scripts/notarize-mac.js`（`build.mac.notarize` 固定为 `false`，避免 electron-builder 用环境变量再公证一次）：

1. 仅 darwin 执行；electron-builder 没签名时不会调用这个钩子；
2. 缺 `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` 时，只打印跳过，不中断构建（fork PR、本地无凭据构建仍能出包）；
3. 有凭据则调用 `@electron/notarize`（notarytool 通道）提交公证，成功后由该库自动 `staple` 票据到 `.app`；
4. dmg / zip 在签名后的 app 基础上打包，安装时 Gatekeeper 校验的是 app 内的票据。

## 5. CI secrets

在仓库 Settings → Secrets and variables → Actions 里配置：

| Secret | 说明 |
| --- | --- |
| `MAC_CERT_P12_BASE64` | Developer ID Application 证书导出为 `.p12` 后 `base64` 的整段文本 |
| `MAC_CERT_PASSWORD` | 导出 p12 时设置的密码 |
| `APPLE_ID` | Apple 开发者账号邮箱 |
| `APPLE_APP_SPECIFIC_PASSWORD` | appleid.apple.com 生成的专用密码（不是账号密码） |
| `APPLE_TEAM_ID` | 开发者团队 ID（10 位） |

导出证书（在装有证书的 Mac 上）：

```bash
# 钥匙串访问 → 我的证书 → Developer ID Application → 导出 .p12
base64 -i DeveloperID.p12 | pbcopy   # 粘贴到 MAC_CERT_P12_BASE64
```

CI 会把 p12 写到 `$RUNNER_TEMP/cert.p12`，通过 `CSC_LINK` 交给 electron-builder；`MAC_SIGNED=1` 时额外跑 `spctl` 校验，签名或公证不完整会直接让 job 失败。

## 6. 本地验证

```bash
codesign --verify --deep --strict --verbose=2 dist/mac-arm64/浮灵饰界.app
spctl -a -vvv -t exec dist/mac-arm64/浮灵饰界.app
xcrun stapler validate dist/mac-arm64/浮灵饰界.app
```

`spctl` 输出 `source=Notarized Developer ID` 即表示公证生效。

## 7. 未签名时的表现

未配置证书时流水线仍产出 dmg，但用户首次打开会被 Gatekeeper 拦截，需要「右键 → 打开」或在系统设置里放行。正式发布前务必配好上面 5 个 secrets。
