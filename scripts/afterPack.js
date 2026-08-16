// afterPack hook: inject the app icon into the main executable so the
// taskbar/window icon matches the desktop shortcut (dph_logo).
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execSync } = require('child_process');

exports.default = async function afterPack(context) {
  const { appOutDir, packager } = context;
  const exeName = packager.appInfo.productFilename + '.exe';
  const exePath = path.join(appOutDir, exeName);
  const iconPath = path.join(packager.projectDir, 'build', 'icon.ico');
  if (!fs.existsSync(exePath) || !fs.existsSync(iconPath)) {
    console.log('[afterPack] exe or icon missing, skip');
    return;
  }
  // locate rcedit: project-local copy first (survives cache wipes), then electron-builder cache
  const localRcedit = path.join(__dirname, 'rcedit-x64.exe');
  let rcedit = null;
  if (fs.existsSync(localRcedit)) {
    rcedit = localRcedit;
  } else {
    const cacheBase = path.join(os.homedir(), 'AppData', 'Local', 'electron-builder', 'Cache', 'winCodeSign');
    if (fs.existsSync(cacheBase)) {
      for (const d of fs.readdirSync(cacheBase)) {
        const cand = path.join(cacheBase, d, 'rcedit-x64.exe');
        if (fs.existsSync(cand)) { rcedit = cand; break; }
      }
    }
  }
  if (!rcedit) {
    console.log('[afterPack] rcedit not found, icon injection skipped');
    return;
  }
  try {
    execSync(`"${rcedit}" "${exePath}" --set-icon "${iconPath}"`, { stdio: 'inherit' });
    console.log('[afterPack] icon injected into ' + exeName);
  } catch (e) {
    console.log('[afterPack] icon injection failed: ' + e.message);
  }
};
