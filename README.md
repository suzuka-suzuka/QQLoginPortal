# QQ Login Portal

QQ Login Portal 是一个独立的 LinuxQQ 网页登录面板。它面向没有图形桌面的 Linux 服务器：在 Xvfb 中启动一个或多个官方 QQ 实例，并把 QQ 登录内核直接给出的二维码显示在受密码保护的网页上。

它不截图、不识别窗口像素，也不依赖 SnowLuma、OneBot 或其他机器人框架。登录完成后，你可以让其他程序按自己的方式连接或注入 QQ；本项目只负责 QQ 登录和实例生命周期。

## 功能

- 直接订阅 `NodeIKernelLoginService`，在网页显示 QQ 内核返回的二维码 PNG。
- 在网页新增账号时只填写 QQ 号；QQ 号就是唯一标识，不再创建显示名称。
- 每个账号使用独立的 HOME、Electron `user-data-dir` 和 Unix Socket，支持多开。
- 网页分为“账号”“扫码登录”“设置”三个页面，可启动、停止、刷新二维码、快速登录、切换自动启动和移除实例；QQ 内核提供相应能力时也可真正退出账号。
- 停止与移除精确限定到所选实例，不使用 `pkill qq`、`pkill node` 等全局命令。
- 移除实例只修改 `config.json`，不会删除磁盘上的账号数据。
- 固定访问密码、会话有效期和实例上限均保存在 `config.json`，可在网页设置中修改。
- 配置文件原子写入，并在 Linux 上保持 `0600` 权限。
- 自带登录限速、同源校验、安全响应头和 `HttpOnly` / `SameSite=Strict` Cookie。

## 工作方式

```text
浏览器
  └─ QQ Login Portal :5100
       ├─ config.json
       ├─ Xvfb（只为 LinuxQQ 提供后台显示环境）
       ├─ QQ 账号 A ─ 通用加载器 ─ 登录 Agent ─ Unix Socket A
       └─ QQ 账号 B ─ 通用加载器 ─ 登录 Agent ─ Unix Socket B
```

加载器只在带有 `--qq-login-instance=<QQ号>` 参数的受管 QQ 主进程中连接 Agent。Electron 的 renderer、GPU 等辅助进程不会被当成实例主进程。

## 要求

- Linux x86_64；当前实现依赖 `/proc` 和 Unix Socket。
- 已安装官方 LinuxQQ，默认路径为 `/opt/QQ/qq`。
- Xvfb。
- Node.js `22.13.0` 或更高版本。

Ubuntu / Debian 可安装 Xvfb：

```bash
sudo apt update
sudo apt install -y xvfb
```

LinuxQQ 请使用腾讯官方安装包。项目不会代替你下载或分发 QQ。

## 快速开始

```bash
git clone https://github.com/suzuka-suzuka/QQLoginPortal.git
cd QQLoginPortal
npm run init-config
```

`init-config` 会生成随机固定密码并写入 `config.json`，不会把密码放进环境变量。随后检查并按需修改配置：

```bash
nano config.json
```

默认只监听 `127.0.0.1:5100`。如果确实需要直接从公网访问，可把监听地址改为：

```json
"host": "0.0.0.0"
```

然后安装 QQ 登录加载器并检查环境：

```bash
sudo node src/cli.mjs loader-install ./config.json
npm run check
npm start
```

加载器安装会：

1. 读取 `/opt/QQ/resources/app/package.json` 的原始 `main`；
2. 创建一次性原始备份 `package.json.qq-login-portal.backup`；
3. 安装 `qq-login-portal-loader.cjs` 和只记录原始入口的元数据；
4. 把 QQ 的入口切换到通用加载器。

不会修改 QQ 的 `application.asar` 或原生模块。QQ 更新后应重新执行 `loader-status`；若更新覆盖了入口，再执行一次 `loader-install`。

## 第一次从网页登录

1. 打开面板并输入 `config.json` 中的固定访问密码。
2. 点击“新增 QQ”。
3. 只填写 QQ 号，并选择是否立即启动、是否随面板自动启动。
4. 立即启动后页面会切到该账号的“扫码登录”页；也可以稍后在账号卡片中点击“启动并登录”或“扫码登录”。
5. 在专用扫码区域用手机 QQ 扫描二维码并确认。多账号同时运行时，先在左侧选择要登录的 QQ，页面只显示这个账号的二维码。
6. 页面显示“已登录”后即可关闭网页；QQ 进程会继续运行。

如果扫入了与卡片 QQ 号不同的账号，Agent 会调用 QQ 内核退出该账号并提示重新扫码，避免把账号数据写进错误实例。

## 多账号隔离

网页新增账号时会自动写入类似配置：

```json
{
  "id": "123456789",
  "uin": "123456789",
  "enabled": true,
  "autostart": false,
  "homeDir": "/home/ubuntu/QQLoginPortal/data/instances/123456789/home",
  "userDataDir": "/home/ubuntu/QQLoginPortal/data/instances/123456789/electron",
  "display": ":1"
}
```

多个实例可以共享一个 Xvfb，因为页面不会读取虚拟屏幕。真正需要隔离的是 HOME、Electron 用户目录、启动参数和 Agent Socket。

## 网页操作的含义

- “启动并登录”：只启动当前卡片对应的 LinuxQQ 主进程，并进入这个账号的扫码页。
- “扫码登录”：进入专用扫码页；二维码过期后可在这里重新生成。
- “停止 QQ”：位于账号卡片的管理菜单中，向该实例的精确主进程发送 `SIGTERM`，不退出 QQ 账号、不清空数据。
- “历史账号快速登录”：由扫码页按 QQ 内核返回的历史账号能力提供，并且只允许当前实例对应的 QQ 号。
- “退出 QQ”：位于管理菜单中；仅在当前 QQ 内核提供 `offline()` 能力时可用，让账号真正下线并回到登录状态。若按钮不可用，停止进程也不等于退出账号。
- “移除账号”：位于管理菜单中，要求实例先停止，只删除面板配置，不删除账号目录。

账号卡片以 QQ 号作为唯一标识，不要求另起显示名称。顶部筛选和搜索可以组合使用；在线账号不会显示无意义的二维码占位图。

停止后若 10 秒仍未退出，面板会报错并保留进程；它不会自动升级为 `SIGKILL`。

## 配置

完整示例见 [`config.example.json`](config.example.json)。主要字段：

- `listen.host` / `listen.port`：网页监听地址与端口。
- `auth.password`：12 到 256 个字符的固定访问密码。
- `auth.sessionTtlMinutes`：会话有效期，5 到 1440 分钟。
- `auth.secureCookie`：只在 HTTPS 入口下设为 `true`。
- `runtime.autostart`：面板启动时是否准备 Xvfb、检查加载器并启动标记为自动启动的实例。
- `runtime.stateDir`：实例 Socket 等短期运行状态目录。
- `runtime.xvfb`：Xvfb 显示号、命令和参数。
- `runtime.qq`：QQ 可执行文件、resources 目录、Agent 入口及启动参数。
- `management.instanceRoot`：网页新增账号的数据根目录。
- `management.maxInstances`：最多允许配置的实例数。
- `instances`：账号实例列表；初始可为空，之后直接从网页添加。

`runtime.qq.args` 不得手工加入实例标识或 `--user-data-dir`，这些参数由面板按账号生成。

## 公网访问安全

直接监听 `0.0.0.0` 只解决可达性，不会自动提供 HTTPS。二维码和登录会话都属于敏感信息，推荐二选一：

- 保持 `127.0.0.1`，通过 SSH 隧道访问：

  ```bash
  ssh -N -L 5100:127.0.0.1:5100 your-server
  ```

- 使用 Caddy、Nginx 或 Cloudflare Tunnel 提供 HTTPS，再把 `secureCookie` 设为 `true`。

若仍选择公网 HTTP，请至少使用高强度固定密码、限制防火墙来源，并理解同网段或链路中间人可能看到流量。

`config.json` 含明文固定密码，必须保持 `0600` 且不能提交到 Git。

## systemd

仓库提供的 [`systemd/qq-login-portal.service`](systemd/qq-login-portal.service) 默认按以下环境编写：

- 用户：`ubuntu`
- 项目目录：`/home/ubuntu/QQLoginPortal`
- Node：`/usr/local/bin/node`

路径不一致时先编辑 unit，然后安装：

```bash
sudo cp systemd/qq-login-portal.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now qq-login-portal
sudo systemctl status qq-login-portal --no-pager
journalctl -u qq-login-portal -n 100 --no-pager
```

受管 QQ 是该 unit 的子进程。停止整个 service 会结束同一 cgroup 中由它启动的 QQ；网页上的“停止”则只结束所选实例。

## 诊断与恢复

```bash
npm run check
npm run loader:status
pgrep -af -- '--qq-login-instance='
ss -ltnp | grep ':5100\b'
```

验证 QQ 内核能否真正返回二维码（探针不会输出二维码内容）：

```bash
node src/cli.mjs probe-kernel ./config.json
```

探针只会结束带有精确 `kernel-probe` 标识的进程。10 秒未退出时不会发送 `SIGKILL`，也不会删除探针数据。

恢复 QQ 原始入口：

```bash
sudo node src/cli.mjs loader-restore ./config.json
```

安装器能识别早期嵌入式预览版留下的加载器与备份，并在不覆盖 QQ 原始入口备份的前提下迁移到通用文件名。运行时也会识别旧实例参数，以免迁移期间把已经运行的 QQ 误判为未启动；新进程始终只使用 `--qq-login-instance=`。

NapCat 同样需要接管 QQ 的启动入口。为避免加载顺序不明或递归启动，本项目检测到 NapCat 入口时会拒绝叠加安装；这不是对 NapCat 的运行依赖。

## 开发与测试

项目本身没有第三方运行时依赖：

```bash
npm test
node --check src/qq-agent.cjs
node --check src/qq-loader.cjs
```

测试覆盖认证、二维码内核回调、账号隔离、配置写入、加载器安装与恢复、旧加载器迁移、精确进程识别和网页 API。
