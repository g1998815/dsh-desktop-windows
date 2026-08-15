// main.js — DSH 桌面版(Electron 壳)主进程。
// 职责:窗口 / 托盘 / 单实例锁 / 对话框 / 应用生命周期。
// 服务管理全部委托给 src/server-manager.js(通过事件解耦)。
const path = require("path");
const { app, BrowserWindow, Tray, Menu, dialog, shell, nativeImage } = require("electron");
const { ServerManager, DEFAULT_DSH_ENTRY } = require("./src/server-manager");
const logger = require("./src/logger");

// 打包版(exe)使用独立应用名/数据目录,避免与开发版(electron .)共享
// userData 导致单实例锁互斥。必须在 requestSingleInstanceLock 之前设置。
if (app.isPackaged) {
  app.setName("DshDesktop");
}

// DSH 入口路径:环境变量 DSH_DESKTOP_DSH_ENTRY 优先,否则用默认全局路径(便于换机器部署)
const DSH_ENTRY = process.env.DSH_DESKTOP_DSH_ENTRY || DEFAULT_DSH_ENTRY;

// 应用图标:窗口/托盘统一从 assets/icon.png 加载(直接替换该文件即可换图标)
const APP_ICON = nativeImage.createFromPath(path.join(__dirname, "assets", "icon.png"));
// Windows 托盘区图标:预缩放到 32x32,避免大图被系统压缩后发虚(覆盖 100%~200% DPI)
const TRAY_ICON = APP_ICON.resize({ width: 32, height: 32, quality: "best" });

const ERROR_PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(`
<!doctype html><html><head><meta charset="utf-8"><title>DSH 桌面版</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#1e1e2e;color:#cdd6f4}
.box{text-align:center;max-width:480px;padding:24px}h1{font-size:18px}p{font-size:13px;line-height:1.7;color:#a6adc8}
code{background:#313244;padding:2px 6px;border-radius:4px}</style></head>
<body><div class="box"><h1>DSH 服务尚未就绪</h1>
<p>服务启动失败或仍在恢复中。请通过系统托盘图标菜单的
<code>重启服务</code>重试,或查看日志:<br><code>~/.dsh-desktop/logs/main.log</code></p>
</div></body></html>`)}`;

let mainWindow = null;   // 主窗口(关闭时隐藏到托盘)
let tray = null;         // 托盘图标
let manager = null;      // 服务管理器
let service = null;      // { port, url, reused }
let isQuitting = false;  // 是否正在退出(决定 close 是否隐藏)

// ---------------------------------------------------------------- 单实例锁
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  app.whenReady().then(bootstrap);
  // 托盘驻留:所有窗口关闭也不退出(退出只能走托盘菜单)
  app.on("window-all-closed", () => { /* 故意留空:不退出 */ });
  app.on("before-quit", () => { isQuitting = true; });
}

// ---------------------------------------------------------------- 启动流程
async function bootstrap() {
  manager = new ServerManager({ logger, dshEntry: DSH_ENTRY });
  manager.on("ready", onServiceReady);
  manager.on("service-exited", ({ code, signal }) => {
    logger.warn(`服务进程退出(code=${code}, signal=${signal}),自动重启中…`);
  });
  manager.on("restarting", ({ attempt, delayMs }) => {
    logger.warn(`${delayMs}ms 后第 ${attempt} 次自动重启`);
  });
  manager.on("giving-up", ({ failures }) => {
    logger.error(`服务连续启动失败 ${failures} 次,停止自动重启`);
    dialog.showErrorBox(
      "DSH 服务启动失败",
      `服务连续启动失败 ${failures} 次,已停止自动重启。\n\n可通过托盘菜单的"重启服务"手动重试。`
    );
  });
  manager.on("error", (err) => logger.error(`服务错误:${err.message}`));

  createWindow();
  createTray();

  try {
    await manager.ensure(); // 'ready' 事件负责记录日志与加载窗口
    loadService();
  } catch (err) {
    logger.error(`启动失败:${err.message}`);
    dialog.showErrorBox(
      "DSH 桌面版启动失败",
      `${err.message}\n\n可通过托盘菜单的"重启服务"重试。\n日志:~/.dsh-desktop/logs/main.log`
    );
    showErrorPage();
  }
}

// ---------------------------------------------------------------- 服务事件
function onServiceReady(info) {
  service = info;
  logger.info(`DSH 服务就绪:${info.url} ${info.reused ? "(复用外部服务)" : "(由桌面版拉起)"}`);
  loadService();
}

function loadService() {
  if (!service || !mainWindow || mainWindow.isDestroyed()) return;
  const current = mainWindow.webContents.getURL();
  if (current.startsWith("data:")) {
    mainWindow.loadURL(service.url);       // 错误页 → 真实地址
  } else if (current !== service.url) {
    mainWindow.loadURL(service.url);       // 端口/地址变化
  } else if (!service.reused) {
    mainWindow.reload();                   // 服务重启后刷新页面
  }
}

function showErrorPage() {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.getURL().startsWith("data:")) return;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(ERROR_PAGE);
}

// ---------------------------------------------------------------- 窗口
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 560,
    title: "DSH 桌面版",
    autoHideMenuBar: true,
    icon: APP_ICON,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });
  // 页面内打开的新窗口/外链交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  // 关闭窗口 = 隐藏到托盘(服务继续运行)
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on("closed", () => { mainWindow = null; });
}

// ---------------------------------------------------------------- 托盘
function createTray() {
  tray = new Tray(TRAY_ICON);
  tray.setToolTip("DSH 桌面版");
  rebuildTrayMenu();
}

function rebuildTrayMenu() {
  const template = [
    { label: "打开窗口", click: () => showMainWindow() },
    { label: "在浏览器打开", click: () => { if (service) shell.openExternal(service.url); } },
    { type: "separator" },
    { label: "重启服务", click: () => restartService() },
    { type: "separator" },
    { label: "退出", click: () => quitApp() }
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    loadService();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

// ---------------------------------------------------------------- 动作
async function restartService() {
  logger.info("用户请求重启服务");
  try {
    await manager.restart();
  } catch (err) {
    logger.error(`服务重启失败:${err.message}`);
    dialog.showErrorBox("服务重启失败", err.message);
    showErrorPage();
  }
}

async function quitApp() {
  const { response } = await dialog.showMessageBox({
    type: "question",
    title: "退出 DSH 桌面版",
    message: "确定退出吗?",
    detail: "退出将停止由桌面版拉起的 DSH 服务;\n外部已运行的服务不受影响。",
    buttons: ["退出", "取消"],
    defaultId: 1,
    cancelId: 1
  });
  if (response !== 0) return;
  logger.info("用户选择退出");
  isQuitting = true;
  try {
    await manager.stop(); // 只停自己拉起的服务
  } catch (err) {
    logger.error(`停止服务失败:${err.message}`);
  }
  app.quit();
}
