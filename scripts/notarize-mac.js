/**
 * macOS 公证（electron-builder afterSign 钩子）。
 *
 * 只有同时具备证书与 Apple 凭据时才执行公证；缺任何一项都只打印跳过，
 * 保证没有 secrets 的本地构建 / fork PR 仍能产出可安装（未签名）的包。
 *
 * CI 需要的 secrets：
 *   CSC_LINK / CSC_KEY_PASSWORD                             签名证书（p12）
 *   APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID  公证凭据
 */
const path = require('path');
const { execFileSync } = require('child_process');

function hasNotarizeCredentials() {
  return Boolean(
    process.env.APPLE_ID &&
      process.env.APPLE_APP_SPECIFIC_PASSWORD &&
      process.env.APPLE_TEAM_ID
  );
}

function isSigned(appPath) {
  try {
    execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], {
      stdio: 'ignore'
    });
    return true;
  } catch (error) {
    return false;
  }
}

exports.default = async function afterSign(context) {
  const { electronPlatformName, appOutDir, packager } = context;
  if (electronPlatformName !== 'darwin') return;

  const appPath = path.join(
    appOutDir,
    `${packager.appInfo.productFilename}.app`
  );

  if (!hasNotarizeCredentials()) {
    console.log(
      '[notarize] 未提供 APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID，跳过公证'
    );
    return;
  }

  if (!isSigned(appPath)) {
    console.log('[notarize] app 未签名或签名校验失败，跳过公证');
    return;
  }

  const { notarize } = require('@electron/notarize');

  console.log(`[notarize] 提交公证：${appPath}`);
  // notarytool 通道；notarize() 成功后会自动 staple 票据到 .app
  await notarize({
    tool: 'notarytool',
    appPath,
    appleId: process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
    teamId: process.env.APPLE_TEAM_ID
  });
  console.log('[notarize] 公证完成，票据已 staple 到 app');
};

// electron-builder 也接受 module.exports 直接为函数
module.exports.notarize = module.exports.default;
