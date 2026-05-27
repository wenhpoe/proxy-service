const { app, BrowserWindow, shell, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_NAME = 'Flow 代理管理服务';
const APP_ID = 'com.internal.flow-proxy-service';
const ICON_PNG = path.join(__dirname, '..', 'build', 'icon.png');
const ICON_ICO = path.join(__dirname, '..', 'build', 'icon.ico');
const ICON_PATH = process.platform === 'win32' ? ICON_ICO : ICON_PNG;

app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);
if (process.platform === 'win32' && process.env.PROXY_DISABLE_HARDWARE_ACCELERATION !== '0') {
  app.disableHardwareAcceleration();
}

let serverHandle = null;
let autoUpdateCtl = null;
let autoUpdateState = { state: 'idle', updatedAt: null, logPath: null };

function startupLogPath() {
  try {
    return path.join(app.getPath('userData'), 'startup.log');
  } catch {
    return path.join(os.tmpdir(), 'flow-proxy-service-startup.log');
  }
}

function appendStartupLog(line) {
  try {
    const msg = `[${new Date().toISOString()}] ${String(line || '').trim()}\n`;
    fs.mkdirSync(path.dirname(startupLogPath()), { recursive: true });
    fs.appendFileSync(startupLogPath(), msg, 'utf8');
  } catch {
    // ignore
  }
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function startupErrorHtml({ title, message, detail } = {}) {
  const logPath = startupLogPath();
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title || '代理服务启动异常')}</title>
    <style>
      :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f3f6ef; color: #182018; }
      .panel { width: min(760px, calc(100vw - 48px)); border: 1px solid rgba(31, 41, 55, .14); border-radius: 22px; background: rgba(255,255,255,.88); box-shadow: 0 20px 60px rgba(15,23,42,.12); padding: 28px; }
      h1 { margin: 0 0 12px; font-size: 24px; }
      p { margin: 0 0 14px; line-height: 1.7; color: #4b5563; }
      pre { white-space: pre-wrap; word-break: break-word; border-radius: 14px; background: #111827; color: #e5e7eb; padding: 16px; max-height: 260px; overflow: auto; }
      .hint { font-size: 13px; color: #64748b; }
    </style>
  </head>
  <body>
    <main class="panel">
      <h1>${escapeHtml(title || '代理服务启动异常')}</h1>
      <p>${escapeHtml(message || '窗口已打开，但管理页面没有成功加载。')}</p>
      <pre>${escapeHtml(detail || '')}</pre>
      <p class="hint">启动日志：${escapeHtml(logPath)}</p>
    </main>
  </body>
</html>`;
}

async function showStartupError(win, title, message, detail) {
  appendStartupLog(`${title}: ${message} ${detail || ''}`);
  if (!win || win.isDestroyed()) return;
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(startupErrorHtml({ title, message, detail }))}`);
  } catch {
    // ignore
  }
  try {
    if (!win.isVisible()) win.show();
  } catch {
    // ignore
  }
}

async function waitForHttpReady(baseUrl, timeoutMs = 6000) {
  const startedAt = Date.now();
  const healthUrl = `${String(baseUrl || '').replace(/\/+$/, '')}/health`;
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1200);
      let res;
      try {
        res = await fetch(healthUrl, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      if (res.ok) return { ok: true };
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { ok: false, error: lastError?.message || 'health check timed out', url: healthUrl };
}

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

  autoUpdateState = { state: 'idle', updatedAt: null, logPath };

  const log = (line) => {
    const msg = `[${new Date().toISOString()}] ${String(line || '').trim()}\n`;
    try {
      if (logPath) fs.appendFileSync(logPath, msg, 'utf8');
    } catch {
      // ignore
    }
  };

  let hasShownAvailable = false;

  const setState = (patch) => {
    try {
      autoUpdateState = { ...autoUpdateState, ...patch, updatedAt: new Date().toISOString() };
    } catch {
      // ignore
    }
    try {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:updateStatus', patch);
    } catch {
      // ignore
    }
  };

  autoUpdater.on('checking-for-update', () => {
    log('checking-for-update');
    setState({ state: 'checking' });
  });
  autoUpdater.on('update-not-available', (info) => {
    log(`update-not-available version=${info?.version || ''}`);
    setState({ state: 'none', version: info?.version || null });
  });

  autoUpdater.on('update-available', async (info) => {
    const v = info?.version || null;
    log(`update-available version=${v || ''}`);
    setState({ state: 'available', version: v });
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
    try {
      autoUpdateState = { ...autoUpdateState, lastError: msg };
    } catch {
      // ignore
    }
    // Keep errors out of the UI by default (user can open auto-update.log).
    setState({ state: 'none' });
  });

  autoUpdater.on('update-downloaded', async (info) => {
    log(`update-downloaded version=${info?.version || ''}`);
    setState({ state: 'downloaded', version: info?.version || null });
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

  autoUpdateCtl = {
    check: async ({ allowPrerelease = false } = {}) => {
      try {
        autoUpdater.allowPrerelease = allowPrerelease === true;
      } catch {
        // ignore
      }
      try {
        await autoUpdater.checkForUpdates();
      } catch (e) {
        log(`checkForUpdates failed: ${e?.message || e}`);
      }
      return { ok: true };
    },
    install: async () => {
      try {
        autoUpdater.quitAndInstall();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e?.message || String(e) };
      }
    },
    openLog: async () => {
      if (!logPath) return { ok: false, error: 'log path unavailable' };
      await shell.openPath(logPath);
      return { ok: true, logPath };
    },
    state: () => autoUpdateState
  };
}

async function createWindow() {
  // Require server after Electron is ready, so server.js can resolve userData correctly.
  const { startServer, getBootstrapInfo } = require('../server');

  // Bind on all interfaces (intranet), but load UI via loopback.
  try {
    appendStartupLog('starting embedded proxy server');
    serverHandle = await startServer();
    appendStartupLog(`embedded proxy server started: ${serverHandle.baseUrl}`);
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err);
    appendStartupLog(`embedded proxy server failed: ${msg}`);
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
        title: '已使用默认管理员密码',
        message: '未检测到 PROXY_ADMIN_PASSWORD，已使用默认管理员密码 123456。',
        detail: `当前密码：${bootstrap.adminPassword}\n\n如需修改，请在配置文件中设置 PROXY_ADMIN_PASSWORD 后重启。\n配置文件位置：${bootstrap.envHint || '（未知）'}`,
      });
    } else if (bootstrap && bootstrap.adminPasswordSource === 'env-auto-created' && bootstrap.adminPassword) {
      dialog.showMessageBox({
        type: 'info',
        title: '已自动创建配置文件',
        message: '首次启动已自动创建 .env，默认管理员密码为 123456。',
        detail: `管理员密码：${bootstrap.adminPassword}\n\n配置文件位置：${bootstrap.envHint || '（未知）'}\n\n后续可直接编辑该文件并重启应用。`,
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
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      devTools: process.env.PROXY_DEVTOOLS !== '0',
    },
  });

  win.once('ready-to-show', () => win.show());
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    appendStartupLog(`renderer console level=${level} ${sourceId || ''}:${line || 0} ${message || ''}`);
  });
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    const url = String(validatedURL || '');
    if (url.startsWith('data:text/html')) return;
    showStartupError(
      win,
      '管理页面加载失败',
      `Electron 无法加载代理端页面：${errorDescription || errorCode}`,
      `URL: ${url || serverHandle?.baseUrl || 'unknown'}\nerrorCode: ${errorCode}\nlog: ${startupLogPath()}`,
    );
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    showStartupError(
      win,
      '管理页面渲染进程异常',
      'Windows 上常见原因是显卡驱动 / GPU 加速 / WebView 渲染进程崩溃。',
      JSON.stringify(details || {}, null, 2),
    );
  });
  win.on('unresponsive', () => {
    appendStartupLog('main window became unresponsive');
  });
  win.webContents.on('before-input-event', (event, input) => {
    const key = String(input?.key || '').toLowerCase();
    if ((input.control || input.meta) && input.shift && key === 'i') {
      event.preventDefault();
      win.webContents.openDevTools({ mode: 'detach' });
    }
  });

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

  const ready = await waitForHttpReady(serverHandle.baseUrl);
  if (!ready.ok) {
    await showStartupError(
      win,
      '代理服务已启动，但页面不可访问',
      '本地接口已监听，但健康检查没有通过。',
      `health: ${ready.url}\nerror: ${ready.error}\nlog: ${startupLogPath()}`,
    );
    return win;
  }

  try {
    await win.loadURL(`${serverHandle.baseUrl}/`);
  } catch (err) {
    await showStartupError(
      win,
      '管理页面加载失败',
      'Electron 加载本地管理页面失败。',
      `${err?.stack || err?.message || String(err)}\nURL: ${serverHandle.baseUrl}/\nlog: ${startupLogPath()}`,
    );
  }
  return win;
}

app.whenReady().then(async () => {
  const win = await createWindow();
  if (win) setupAutoUpdate(win);

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
});

ipcMain.handle('app:info', async () => ({
  appVersion: app.getVersion(),
  isPackaged: app.isPackaged,
  platform: process.platform,
  update: autoUpdateCtl ? autoUpdateCtl.state() : autoUpdateState
}));

ipcMain.handle('update:check', async (_evt, opts) => {
  if (!autoUpdateCtl) return { ok: false, error: 'auto update not available' };
  try {
    return await autoUpdateCtl.check(opts && typeof opts === 'object' ? opts : {});
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});
ipcMain.handle('update:install', async () => {
  if (!autoUpdateCtl) return { ok: false, error: 'auto update not available' };
  return autoUpdateCtl.install();
});
ipcMain.handle('update:openLog', async () => {
  if (!autoUpdateCtl) return { ok: false, error: 'auto update not available' };
  try {
    return await autoUpdateCtl.openLog();
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
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
