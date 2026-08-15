// test/server-manager.test.js — node:test 单测:端口分类/端口选择/退避/重启决策。
// 只测 src/server-manager.js 的纯逻辑,不依赖 Electron。
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  classifyProbe,
  choosePortRange,
  backoffDelayMs,
  shouldGiveUp,
  MAX_CONSECUTIVE_FAILURES,
  BACKOFF_CAP_MS
} = require("../src/server-manager");

// ---------------------------------------------------------------- 端口状态分类
test("classifyProbe:TCP 不可连 → free", () => {
  assert.equal(classifyProbe({ tcpOpen: false, isDsh: false }), "free");
});

test("classifyProbe:TCP 可连且是 dsh → dsh", () => {
  assert.equal(classifyProbe({ tcpOpen: true, isDsh: true }), "dsh");
});

test("classifyProbe:TCP 可连但不是 dsh → other", () => {
  assert.equal(classifyProbe({ tcpOpen: true, isDsh: false }), "other");
});

// ---------------------------------------------------------------- 端口选择
test("choosePortRange:首选端口是 dsh → 复用 3080", async () => {
  const statusOf = async (port) => (port === 3080 ? "dsh" : "free");
  const d = await choosePortRange(3080, 3090, statusOf);
  assert.deepEqual(d, { action: "reuse", port: 3080 });
});

test("choosePortRange:首选端口空闲 → 拉起 3080", async () => {
  const d = await choosePortRange(3080, 3090, async () => "free");
  assert.deepEqual(d, { action: "spawn", port: 3080 });
});

test("choosePortRange:3080 被其他占用 → 向后扫描,遇空闲拉起", async () => {
  const statusOf = async (port) => (port === 3080 || port === 3081 || port === 3082 ? "other" : "free");
  const d = await choosePortRange(3080, 3090, statusOf);
  assert.deepEqual(d, { action: "spawn", port: 3083 });
});

test("choosePortRange:扫描中遇到 dsh 服务 → 复用", async () => {
  const statusOf = async (port) => (port <= 3084 ? "other" : port === 3085 ? "dsh" : "free");
  const d = await choosePortRange(3080, 3090, statusOf);
  assert.deepEqual(d, { action: "reuse", port: 3085 });
});

test("choosePortRange:3080~3090 全被占用 → error", async () => {
  const d = await choosePortRange(3080, 3090, async () => "other");
  assert.equal(d.action, "error");
  assert.equal(d.reason, "all-ports-occupied");
});

test("choosePortRange:边界 3090 空闲也可选", async () => {
  const statusOf = async (port) => (port <= 3089 ? "other" : "free");
  const d = await choosePortRange(3080, 3090, statusOf);
  assert.deepEqual(d, { action: "spawn", port: 3090 });
});

// ---------------------------------------------------------------- 指数退避
test("backoffDelayMs:指数增长 1s/2s/4s/8s", () => {
  assert.equal(backoffDelayMs(1), 1000);
  assert.equal(backoffDelayMs(2), 2000);
  assert.equal(backoffDelayMs(3), 4000);
  assert.equal(backoffDelayMs(4), 8000);
});

test("backoffDelayMs:封顶 30s", () => {
  assert.equal(backoffDelayMs(6), BACKOFF_CAP_MS);
  assert.equal(backoffDelayMs(10), BACKOFF_CAP_MS);
});

// ---------------------------------------------------------------- 重启次数限制
test("shouldGiveUp:未达阈值不放弃", () => {
  assert.equal(shouldGiveUp(0), false);
  assert.equal(shouldGiveUp(MAX_CONSECUTIVE_FAILURES - 1), false);
});

test("shouldGiveUp:达到 5 次放弃", () => {
  assert.equal(shouldGiveUp(MAX_CONSECUTIVE_FAILURES), true);
  assert.equal(shouldGiveUp(6), true);
});
