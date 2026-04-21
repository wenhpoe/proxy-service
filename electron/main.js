const { app, BrowserWindow, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const APP_NAME = 'Flow 代理管理服务';
const APP_ID = 'com.internal.flow-proxy-service';
const ICON_PNG = path.join(__dirname, '..', 'build', 'icon.png');
const ICON_ICO = path.join(__dirname, '..', 'build', 'icon.ico');
const ICON_PATH = process.platform === 'win32' ? ICON_ICO : ICON_PNG;

app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

let serverHandle = null;

function setupAutoUpdate(mainWindow) {
  if (!app.isPackaged) return;
  if (process.env.PROXY_AUTO_UPDATE === '0') return;

  let autoUpdater;
  try {
    // eslint-disable-next-line global-require
    ({ autoUpdater } = require('electron-updater'));
  } catch (e) {
    console.warn(`⚠️ 自动更新组件不可用：${e?.message || e}`);
    return;
  }

  autoUpdater.autoDownload = true;

  const logPath = (() => {
    try {
      return path.join(app.getPath('userData'), 'auto-update.log');
    } catch {
      return null;
    }
  })();

  const log = (line) => {
    const msg = `[${new Date().toISOString()}] ${String(line || '').trim()}\n`;
    try {
      if (logPath) fs.appendFileSync(logPath, msg, 'utf8');
    } catch {
      // ignore
    }
  };

  let hasShownAvailable = false;
  let hasShownError = false;

  autoUpdater.on('checking-for-update', () => log('checking-for-update'));
  autoUpdater.on('update-not-available', (info) => log(`update-not-available version=${info?.version || ''}`));

  autoUpdater.on('update-available', async (info) => {
    const v = info?.version || null;
    log(`update-available version=${v || ''}`);
    if (hasShownAvailable) return;
    hasShownAvailable = true;
    try {
      await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: '发现新版本',
        message: `发现新版本 ${v || ''}，正在后台下载…`,
        buttons: ['知道了'],
        defaultId: 0,
        noLink: true,
      });
    } catch {
      // ignore
    }
  });

  autoUpdater.on('error', async (err) => {
    const msg = err?.message || String(err);
    log(`error ${msg}`);
    if (hasShownError) return;
    hasShownError = true;
    try {
      dialog.showErrorBox(
        '自动更新失败',
        `自动更新检查/下载失败。\n\n错误信息：${msg}\n\n排查建议：\n- 确认 GitHub Release 不是 Draft/Pre-release\n- 确认 Release 里有 latest.yml（Windows）或 latest-mac.yml + .zip（macOS）\n- macOS 请确保应用已安装到“应用程序”目录后再启动\n\n日志：${logPath || '（不可用）'}`,
      );
    } catch {
      // ignore
    }
  });

  autoUpdater.on('update-downloaded', async (info) => {
    log(`update-downloaded version=${info?.version || ''}`);
    try {
      const r = await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: '发现新版本',
        message: `已下载新版本 ${info?.version || ''}，是否立即重启更新？`,
        buttons: ['立即重启', '稍后'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (r.response === 0) autoUpdater.quitAndInstall();
    } catch {
      // ignore
    }
  });

  autoUpdater.checkForUpdates().catch((e) => {
    log(`checkForUpdates failed: ${e?.message || e}`);
    console.warn(`⚠️ 自动更新检查失败：${e?.message || e}`);
  });
}

async function createWindow() {
  // Require server after Electron is ready, so server.js can resolve userData correctly.
  const { startServer, getBootstrapInfo } = require('../server');

  // Bind on all interfaces (intranet), but load UI via loopback.
  try {
    serverHandle = await startServer();
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err);
    dialog.showErrorBox(
      '代理服务启动失败',
      `无法启动接口服务。\n\n常见原因：端口被占用（默认 3123）、权限/防火墙限制。\n\n错误信息：${msg}\n\n请先释放端口或修改环境变量 PROXY_SERVICE_PORT 后重试。`,
    );
    app.quit();
    return null;
  }

  // If admin password is auto-generated, show it once to avoid “验证密码失败” confusion in packaged app.
  try {
    const bootstrap = typeof getBootstrapInfo === 'function' ? getBootstrapInfo() : null;
    if (bootstrap && bootstrap.adminPasswordSource === 'generated' && bootstrap.adminPassword) {
      dialog.showMessageBox({
        type: 'warning',
        title: '管理员密码未配置',
        message: '未检测到 PROXY_ADMIN_PASSWORD，已为本次启动生成临时管理员密码。',
        detail: `临时密码：${bootstrap.adminPassword}\n\n建议：在配置文件中设置固定密码后重启。\n配置文件位置：${bootstrap.envHint || '（未知）'}`,
      });
    }
  } catch {
    // ignore
  }

  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 1020,
    minHeight: 680,
    backgroundColor: '#f3f6ef',
    show: false,
    autoHideMenuBar: true,
    title: 'Proxy Service',
    icon: ICON_PATH,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      devTools: process.env.PROXY_DEVTOOLS === '1',
    },
  });

  win.once('ready-to-show', () => win.show());

  // Open external links in default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!serverHandle?.baseUrl) return;
    if (url.startsWith(serverHandle.baseUrl)) return;
    e.preventDefault();
    shell.openExternal(url);
  });

  await win.loadURL(`${serverHandle.baseUrl}/`);
  return win;
}

app.whenReady().then(async () => {
  const win = await createWindow();
  if (win) setupAutoUpdate(win);

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
});

async function shutdown() {
  if (!serverHandle?.server) return;
  await new Promise((resolve) => serverHandle.server.close(() => resolve()));
  serverHandle = null;
}

app.on('before-quit', (e) => {
  // Ensure we stop the embedded server.
  e.preventDefault();
  shutdown()
    .catch(() => {})
    .finally(() => app.exit(0));
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
