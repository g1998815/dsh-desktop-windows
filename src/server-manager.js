// src/server-manager.js — dsh web 服务管理:端口探测、拉起、守护重启、换端口。
// 纯逻辑(端口分类/选择/退避/次数限制)为独立函数,可脱离 Electron 单测;
// IO(网络探测、子进程)通过构造函数注入,便于测试与解耦。
const { EventEmitter } = require("node:events");
const net = require("node:net");
const { spawn } = require("node:child_process");
const path = require("node:path");

const DEFAULT_PORT = 3080;
const PORT_RANGE_END = 3090;
const READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 500;
const MAX_CONSECUTIVE_FAILURES = 5; // 连续失败 5 次后停止自动重启
const BACKOFF_CAP_MS = 30_000;
const DEFAULT_DSH_ENTRY = "E:\\Program Files\\nodejs\\node_global\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js";

// ---------------------------------------------------------------- 纯逻辑

/** 把一次探测结果归类为端口状态。 */
function classifyProbe({ tcpOpen, isDsh }) {
  if (!tcpOpen) return "free";
  return isDsh ? "dsh" : "other";
}

/**
 * 在 [preferred, rangeEnd] 端口范围内决策:
 * - 首选端口是 dsh → 复用;空闲 → 拉起
 * - 首选被其他程序占用 → 向后扫描,遇 dsh 复用、遇空闲拉起
 * - 全部被占 → { action: "error" }
 * @param {number} preferred 首选端口(3080)
 * @param {number} rangeEnd 扫描终点(3090)
 * @param {(port: number) => Promise<string>} statusOf 返回 'free'|'dsh'|'other'
 */
async function choosePortRange(preferred, rangeEnd, statusOf) {
  const first = await statusOf(preferred);
  if (first === "dsh") return { action: "reuse", port: preferred };
  if (first === "free") return { action: "spawn", port: preferred };
  for (let port = preferred + 1; port <= rangeEnd; port++) {
    const s = await statusOf(port);
    if (s === "dsh") return { action: "reuse", port };
    if (s === "free") return { action: "spawn", port };
  }
  return { action: "error", reason: "all-ports-occupied" };
}

/** 指数退避:1s、2s、4s…封顶 30s。attempt 从 1 起。 */
function backoffDelayMs(attempt) {
  const ms = 1000 * 2 ** (attempt - 1);
  return Math.min(ms, BACKOFF_CAP_MS);
}

/** 连续失败次数是否达到停止自动重启的阈值。 */
function shouldGiveUp(consecutiveFailures) {
  return consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
}

// ---------------------------------------------------------------- IO 实现

/** 默认端口探测:TCP 连 127.0.0.1,发 HTTP GET /,看响应是否含 dsh 特征。 */
function defaultProbe(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port, timeout: 800 });
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(r);
    };
    socket.once("connect", () => {
      socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    });
    let data = "";
    socket.on("data", (chunk) => { data += chunk.toString("utf8"); });
    socket.once("close", () => finish({ tcpOpen: true, isDsh: data.includes("DeepSeek Harness") }));
    socket.once("timeout", () => finish({ tcpOpen: false, isDsh: false }));
    socket.once("error", () => finish({ tcpOpen: false, isDsh: false }));
  });
}

// ---------------------------------------------------------------- 管理器

/**
 * 服务管理。事件:
 * - 'ready' ({ port, url, reused })          服务就绪
 * - 'service-exited' ({ code, signal })      自拉起服务进程退出(崩溃或被杀)
 * - 'restarting' ({ attempt, delayMs })      即将退避后重启
 * - 'giving-up' ({ failures })               连续失败达上限,停止自动重启
 * - 'error' (Error)                          致命错误(端口全占、拉起失败、就绪超时)
 */
class ServerManager extends EventEmitter {
  /**
   * @param {object} opts
   * @param {object} opts.logger                logger.info/warn/error/debug
   * @param {string} [opts.dshEntry]            dsh 入口 bin.js 路径
   * @param {(port:number)=>Promise<{tcpOpen:boolean,isDsh:boolean}>} [opts.probePort]
   * @param {(entry:string,port:number)=>import('node:child_process').ChildProcess} [opts.spawnService]
   */
  constructor({ logger, dshEntry = DEFAULT_DSH_ENTRY, probePort = defaultProbe, spawnService = defaultSpawnService } = {}) {
    super();
    this.logger = logger;
    this.dshEntry = dshEntry;
    this.probePort = probePort;
    this.spawnService = spawnService;
    this.proc = null;           // 自拉起的子进程
    this.port = null;           // 当前服务端口
    this.url = null;
    this.reused = false;        // 是否复用了外部已有服务
    this.exiting = false;       // 主动停止标志,抑制崩溃重启
    this.failures = 0;          // 连续失败次数
    this._restartTimer = null;
  }

  /** 是否由本管理器拉起了服务。 */
  get isOwned() {
    return this.proc !== null;
  }

  /**
   * 确保服务可用:探测端口 → 复用或拉起 → 轮询就绪。
   * @returns {Promise<{port:number,url:string,reused:boolean}>}
   */
  async ensure() {
    this.exiting = false;
    const decision = await choosePortRange(DEFAULT_PORT, PORT_RANGE_END, async (port) => {
      const result = await this.probePort(port);
      return classifyProbe(result);
    });
    if (decision.action === "error") {
      const err = new Error("端口 3080~3090 均被其他程序占用,请释放端口后重试");
      this.logger.error(err.message);
      this.emit("error", err);
      throw err;
    }
    if (decision.action === "reuse") {
      this.reused = true;
      this.port = decision.port;
      this.url = `http://127.0.0.1:${decision.port}`;
      this.logger.info(`复用外部 dsh 服务:${this.url}`);
      this.emit("ready", { port: this.port, url: this.url, reused: true });
      return { port: this.port, url: this.url, reused: true };
    }
    // spawn
    this.reused = false;
    await this._spawn(decision.port);
    await this._waitReady(decision.port);
    this.port = decision.port;
    this.url = `http://127.0.0.1:${decision.port}`;
    this.logger.info(`dsh 服务就绪:${this.url} (自拉起)`);
    this.emit("ready", { port: this.port, url: this.url, reused: false });
    return { port: this.port, url: this.url, reused: false };
  }

  /** 停掉自己拉起的服务(外部已有服务不碰)。 */
  async stop() {
    this.exiting = true;
    if (this._restartTimer) { clearTimeout(this._restartTimer); this._restartTimer = null; }
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      this.logger.info("停止自拉起的 dsh 服务");
      await new Promise((resolve) => {
        proc.once("exit", resolve);
        proc.kill();
        setTimeout(resolve, 3000); // 兜底,避免 kill 后 exit 事件丢失导致挂起
      });
    }
  }

  /** 重启服务:停掉自拉起服务 → 重新 ensure。 */
  async restart() {
    this.logger.info("重启服务");
    await this.stop();
    this.failures = 0;
    return this.ensure();
  }

  /** 拉起 dsh web 子进程并挂守护。 */
  async _spawn(port) {
    this.logger.info(`拉起 dsh web(端口 ${port}):node ${this.dshEntry} web --port ${port}`);
    const proc = this.spawnService(this.dshEntry, port);
    this.proc = proc;
    const self = this;
    proc.on("exit", (code, signal) => {
      if (self.exiting) return; // 主动停止,不重启
      self.logger.warn(`服务进程退出 code=${code} signal=${signal}`);
      self.emit("service-exited", { code, signal });
      self._scheduleRestart(port);
    });
    proc.on("error", (err) => {
      self.logger.error(`服务进程错误:${err.message}`);
      if (self.exiting) return;
      self.emit("error", err);
      self._scheduleRestart(port);
    });
  }

  /** 指数退避重启;连续失败达上限则放弃并通知。 */
  _scheduleRestart(port) {
    if (this._restartTimer) return;
    this.failures += 1;
    if (shouldGiveUp(this.failures)) {
      this.logger.error(`连续失败 ${this.failures} 次,停止自动重启`);
      this.emit("giving-up", { failures: this.failures });
      return;
    }
    const delayMs = backoffDelayMs(this.failures);
    this.logger.warn(`${delayMs}ms 后自动重启(第 ${this.failures} 次尝试)`);
    this.emit("restarting", { attempt: this.failures, delayMs });
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      if (this.exiting) return;
      this._spawn(port).catch((err) => {
        this.logger.error(`重启失败:${err.message}`);
        this.emit("error", err);
      });
    }, delayMs);
  }

  /** 轮询端口直到确认为 dsh 服务或超时。 */
  async _waitReady(port, timeoutMs = READY_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await this.probePort(port);
      if (result.tcpOpen && result.isDsh) return;
      await new Promise((r) => setTimeout(r, READY_POLL_MS));
    }
    const err = new Error(`服务启动超时(60s 内未就绪,端口 ${port})`);
    this.logger.error(err.message);
    this.emit("error", err);
    throw err;
  }
}

/** 默认拉起实现:node <dshEntry> web --port <port>,隐藏窗口。 */
function defaultSpawnService(dshEntry, port) {
  return spawn("node", [dshEntry, "web", "--port", String(port)], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

module.exports = {
  DEFAULT_PORT,
  PORT_RANGE_END,
  READY_TIMEOUT_MS,
  MAX_CONSECUTIVE_FAILURES,
  BACKOFF_CAP_MS,
  DEFAULT_DSH_ENTRY,
  classifyProbe,
  choosePortRange,
  backoffDelayMs,
  shouldGiveUp,
  defaultProbe,
  ServerManager
};
