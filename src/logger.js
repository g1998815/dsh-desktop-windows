// src/logger.js — 统一日志落盘:~/.dsh-desktop/logs/main.log
// 轮转策略:单文件超过 1MB 时轮转,保留 main.log + main.log.1 ~ main.log.4 共 5 份。
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const LOG_DIR = path.join(os.homedir(), ".dsh-desktop", "logs");
const LOG_FILE = path.join(LOG_DIR, "main.log");
const MAX_BACKUPS = 4; // main.log.1 ... main.log.4
const ROTATE_SIZE = 1024 * 1024; // 1MB

/** 轮转:删除最旧的备份,依次后移,当前文件变为 .1。 */
function rotate() {
  const last = path.join(LOG_DIR, `main.log.${MAX_BACKUPS}`);
  try { fs.unlinkSync(last); } catch { /* 不存在则忽略 */ }
  for (let i = MAX_BACKUPS - 1; i >= 1; i--) {
    const from = path.join(LOG_DIR, `main.log.${i}`);
    const to = path.join(LOG_DIR, `main.log.${i + 1}`);
    try { fs.renameSync(from, to); } catch { /* 不存在则忽略 */ }
  }
  try { fs.renameSync(LOG_FILE, path.join(LOG_DIR, "main.log.1")); } catch { /* 无当前文件则忽略 */ }
}

function ensureDir() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function write(level, message) {
  try {
    ensureDir();
    try {
      const stat = fs.statSync(LOG_FILE);
      if (stat.size > ROTATE_SIZE) rotate();
    } catch { /* 文件尚不存在 */ }
    const line = `${new Date().toISOString()} [${level}] ${message}\n`;
    fs.appendFileSync(LOG_FILE, line, "utf8");
  } catch (err) {
    // 日志失败不致命:回退到 stderr,避免影响主流程
    process.stderr.write(`[${level}] ${message} (log write failed: ${err.message})\n`);
  }
}

module.exports = {
  logDir: LOG_DIR,
  logFile: LOG_FILE,
  info: (message) => write("INFO", message),
  warn: (message) => write("WARN", message),
  error: (message) => write("ERROR", message),
  debug: (message) => write("DEBUG", message)
};
