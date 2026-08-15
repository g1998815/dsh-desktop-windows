# DshDesktop — DSH 桌面版(Electron 壳)

> 用独立 Electron 桌面应用包装 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(DSH) Web 界面,
> 双击即开,托盘驻留,无需手动开浏览器输地址。

**托盘驻留模式**:关闭窗口最小化到托盘,托盘"退出"才真正停止服务。
壳**不修改** DSH 本体(全局安装的 `@deepseek-ai/dsh`)与 `~/.dsh` 配置,是独立可移植的小项目。

## ✨ 功能特性

- 🖥️ **桌面窗口化**:加载 `http://127.0.0.1:3080`,窗口即 DSH Web
- 🧲 **单实例锁**:重复启动聚焦已有窗口,不会出现两个壳各自拉起服务
- 🔍 **智能端口探测**:
  - 3080 已是 DSH 服务 → 直接复用(不重复拉起)
  - 端口空闲 → 自动拉起 `dsh web`
  - 被其他程序占用 → 扫描 3081~3090 找空闲端口
- 🛡️ **服务守护**:崩溃自动重启,指数退避(1s→30s 封顶),连续失败 5 次停止并提示
- 📌 **托盘菜单**:打开窗口 / 浏览器打开 / 重启服务 / 退出(退出只停自己拉起的服务)
- 📝 **日志落盘**:`~/.dsh-desktop/logs/main.log`,超 1MB 轮转保留 5 份
- 📦 **双形态打包**:NSIS 安装版 + 便携版(见下方"打包为 exe")

## 🚀 快速开始

### 环境要求

| 依赖 | 说明 |
|---|---|
| Node.js ≥ 18 | 开发机已验证 v24 |
| 全局 DSH | 提供 `dsh web` / `lib/bin.js`,壳本身**不包含** DSH |
| Windows | `start.vbs` + 托盘设计(跨平台需另行适配) |

### 安装与启动

```bash
npm install          # 安装依赖(国内可设 ELECTRON_MIRROR 镜像)
npm start            # 或双击 start.vbs(隐藏控制台窗口)
```

启动后自动完成:单实例锁 → 端口探测(复用/拉起/换端口)→ 轮询就绪(60s 超时)→ 创建窗口与托盘。

### 托盘使用

| 操作 | 行为 |
|---|---|
| 关闭窗口 | 隐藏到托盘,服务继续运行 |
| 打开窗口 | 显示并聚焦窗口 |
| 在浏览器打开 | 系统浏览器打开同一地址 |
| 重启服务 | 停止自拉起服务 → 重新拉起 → 窗口刷新 |
| 退出 | 确认后停止**自己拉起**的服务(外部服务不碰),退出 |

## 📦 打包为 exe

```bash
npm run build        # 同时产出安装版 + 便携版
npm run build:nsis   # 仅 NSIS 安装版(推荐日常使用,启动快)
npm run build:portable  # 仅便携版(绿色免安装)
```

产物输出到 `release/`:

| 文件 | 说明 |
|---|---|
| `DshDesktop-<版本>-setup.exe` | **安装版**:向导式安装、可改目录、桌面+开始菜单快捷方式,启动秒开 |
| `DshDesktop-<版本>-portable.exe` | **便携版**:免安装,U 盘可带;每次启动解压到临时目录,启动略慢 |

国内网络下先设镜像再打包:

```bash
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
npm run build
```

## 🖥️ 部署到新机器

1. 新机器**先安装全局 DSH**:`npm i -g @deepseek-ai/dsh`(或 DSH 官方安装方式)
2. 安装 `DshDesktop-<版本>-setup.exe`,或拷贝便携 exe 到任意目录双击运行
3. DSH 安装位置非默认路径时,设置环境变量后启动:
   ```bash
   set DSH_DESKTOP_DSH_ENTRY=D:\path\to\dsh\lib\bin.js
   ```
4. 首次使用在 DSH Web 界面配置模型 API(如 DeepSeek API Key)——这是 DSH 自己的配置,壳不涉及、不存储任何密钥

> exe 只是桌面壳,运行依赖目标机器的全局 DSH,不携带 DSH 本体。

## 🧪 测试

纯逻辑(端口状态判断、端口扫描选择、重启退避与次数限制)用 Node 内置 `node:test` 单测,不依赖 Electron:

```bash
npm test
```

## 📁 目录结构

```
dsh-desktop/
├── package.json              # main: main.js;build 配置(electron-builder)
├── main.js                   # 入口:app 生命周期 / 单实例锁 / 窗口 / 托盘
├── assets/
│   └── icon.png              # 运行时窗口/托盘图标(替换即换图标)
├── build/
│   └── icon.png              # 打包用应用图标(512x512)
├── src/
│   ├── server-manager.js     # 端口探测、spawn+守护 dsh web、崩溃重启、换端口
│   └── logger.js             # 日志落盘 ~/.dsh-desktop/logs/main.log(轮转 5 份)
├── start.vbs                 # 双击启动脚本(隐藏控制台窗口,调 electron .)
├── README.md
├── test/
│   └── server-manager.test.js  # node:test 单测
└── release/                  # 打包产物(已 gitignore)
```

## 📝 日志

统一落盘 `~/.dsh-desktop/logs/main.log`,单文件超 1MB 轮转,保留 `main.log` + `main.log.1` ~ `main.log.4` 共 5 份。

## ✅ 手动冒烟验证清单

> 桌面行为(托盘、关窗隐藏、退出联动)需手动验证。

- [ ] 双击 `start.vbs` 或运行 exe,窗口自动打开,页面正常
- [ ] 托盘出现图标;关闭窗口后进程仍在,托盘"打开窗口"可恢复
- [ ] 托盘"在浏览器打开"用系统浏览器打开同一地址
- [ ] 托盘"重启服务":服务重启,窗口自动刷新
- [ ] 托盘"退出":确认后进程完全退出
- [ ] 先手动启动 `dsh web` 再打开桌面版:复用已有服务(不重复拉起)
- [ ] 占用 3080 后打开桌面版:自动换到 3081+ 拉起
- [ ] 杀掉自拉起的 node 服务:观察自动重启(指数退避)
- [ ] 服务连续失败 5 次:弹提示,托盘仍可"重启服务"
- [ ] 查看日志有完整启动/退出记录

## ⚠️ 明确不做的(YAGNI)

- 不携带 DSH 本体(保持壳的独立性)
- 不做自动更新、开机自启、多语言
- 不修改 DSH 本体与 `~/.dsh` 下的任何配置
- 不做签名(当前 exe 无代码签名,Windows SmartScreen 可能提示)

## 📄 License

MIT
