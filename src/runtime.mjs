import { spawn } from 'node:child_process';
import { access, mkdir, readFile, readdir } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { inspectLoader } from './loader-install.mjs';

const AGENT_STATUS_TIMEOUT_MS = 1_500;
const AGENT_COMMAND_TIMEOUT_MS = 8_000;
const AGENT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const INSTANCE_PREFIX = '--qq-login-instance=';
const LEGACY_INSTANCE_PREFIX = '--snowluma-instance=';

export function displaySocketPath(display) {
  const match = /^:(\d+)$/.exec(display);
  if (!match) throw new Error(`无效 DISPLAY：${display}`);
  return path.join('/tmp/.X11-unix', `X${match[1]}`);
}

export async function isDisplayReady(display) {
  try {
    await access(displaySocketPath(display));
    return true;
  } catch {
    return false;
  }
}

async function isAccessible(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function parseCmdline(raw) {
  return raw.toString('utf8').split('\0').filter(Boolean);
}

export async function listInstanceProcesses(command, instanceId, procRoot = '/proc', aliases = []) {
  if (process.platform !== 'linux' && procRoot === '/proc') return [];
  let entries;
  try {
    entries = await readdir(procRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const ids = new Set([instanceId, ...aliases].filter(Boolean));
  const instanceArgs = new Set([...ids].flatMap(id => [
    `${INSTANCE_PREFIX}${id}`,
    `${LEGACY_INSTANCE_PREFIX}${id}`,
  ]));
  const expectedName = path.basename(command);
  const matches = [];
  await Promise.all(entries
    .filter(entry => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map(async entry => {
      try {
        const args = parseCmdline(await readFile(path.join(procRoot, entry.name, 'cmdline')));
        if (args.some(arg => arg.startsWith('--type='))) return;
        if (path.basename(args[0] ?? '') !== expectedName) return;
        if (args.some(arg => instanceArgs.has(arg))) matches.push(Number(entry.name));
      } catch {
        // Processes can disappear while /proc is scanned.
      }
    }));
  return matches.sort((a, b) => a - b);
}

function startDetached(spec, env, log) {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: { ...process.env, ...env },
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      log(`已启动 ${spec.label}，PID=${child.pid}`);
      resolve(child.pid);
    });
  });
}

async function waitUntil(check, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return check();
}

async function ensureDir(target) {
  await mkdir(target, { recursive: true, mode: 0o700 });
}

export async function requestAgent(socketPath, request, {
  timeoutMs = AGENT_STATUS_TIMEOUT_MS,
  maxResponseBytes = AGENT_MAX_RESPONSE_BYTES,
} = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const chunks = [];
    let size = 0;
    let settled = false;
    const done = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', chunk => {
      size += chunk.length;
      if (size > maxResponseBytes) return done(new Error('登录 Agent 响应过大'));
      chunks.push(chunk);
      const all = Buffer.concat(chunks);
      const newline = all.indexOf(0x0a);
      if (newline < 0) return;
      let response;
      try { response = JSON.parse(all.subarray(0, newline).toString('utf8')); } catch {
        return done(new Error('登录 Agent 返回了无效 JSON'));
      }
      if (!response?.ok) return done(new Error(response?.error || '登录 Agent 操作失败'));
      done(null, response);
    });
    socket.once('timeout', () => done(new Error('登录 Agent 响应超时')));
    socket.once('error', error => done(error));
    socket.once('end', () => {
      if (!settled) done(new Error('登录 Agent 提前关闭连接'));
    });
  });
}

async function ensureDisplay(config, log, display = config.runtime.xvfb.display) {
  const { xvfb } = config.runtime;
  if (await isDisplayReady(display)) return 'existing';
  let replaced = false;
  const args = xvfb.args.map(arg => {
    if (!replaced && /^:\d{1,4}$/.test(arg)) {
      replaced = true;
      return display;
    }
    return arg;
  });
  if (!replaced) args.unshift(display);
  await startDetached({ ...xvfb, args, cwd: undefined, label: `Xvfb ${display}` }, {}, log);
  if (!await waitUntil(() => isDisplayReady(display), 8_000)) {
    throw new Error(`Xvfb 已启动，但 ${displaySocketPath(display)} 未出现`);
  }
  return 'started';
}

export class QQInstanceManager {
  constructor(config, {
    procRoot = '/proc',
    inspectLoaderFn = inspectLoader,
    requestAgentFn = requestAgent,
    spawnFn = startDetached,
    ensureDisplayFn = ensureDisplay,
    killFn = (pid, signal) => process.kill(pid, signal),
    waitFn = waitUntil,
    configStore = null,
    log = message => console.log(`[运行环境] ${message}`),
  } = {}) {
    this.config = config;
    this.procRoot = procRoot;
    this.inspectLoader = inspectLoaderFn;
    this.requestAgent = requestAgentFn;
    this.spawn = spawnFn;
    this.ensureDisplay = ensureDisplayFn;
    this.kill = killFn;
    this.wait = waitFn;
    this.configStore = configStore;
    this.log = log;
    this.bootstrap = null;
    this.bootstrapError = '';
    this.instanceErrors = new Map();
    this.starting = new Map();
    this.stopping = new Map();
    this.displayStarts = new Map();
  }

  instance(id) {
    const instance = this.config.instances.find(item => item.id === id);
    if (!instance) throw new Error(`不存在 QQ 实例：${id}`);
    return instance;
  }

  processIdentity(instance) {
    return instance.uin || instance.id;
  }

  async findPids(instance) {
    const identity = this.processIdentity(instance);
    const aliases = identity === instance.id ? [] : [instance.id];
    return listInstanceProcesses(this.config.runtime.qq.command, identity, this.procRoot, aliases);
  }

  async startInstance(id) {
    const instance = this.instance(id);
    if (!instance.enabled) throw new Error(`QQ 实例 ${instance.uin || instance.id} 已在配置中停用`);
    if (this.starting.has(id)) return this.starting.get(id);
    const promise = this.startInstanceInner(instance)
      .finally(() => this.starting.delete(id));
    this.starting.set(id, promise);
    return promise;
  }

  async startInstanceInner(instance) {
    if (process.platform !== 'linux' && this.procRoot === '/proc') {
      throw new Error('QQ 实例自动启动仅支持 Linux');
    }
    const installed = await this.inspectLoader(this.config.runtime.qq.resourcesDir);
    if (!installed.installed) throw new Error(`${installed.message}；请先执行 loader install`);
    const existing = await this.findPids(instance);
    if (existing.length > 0) {
      this.instanceErrors.delete(instance.id);
      return { started: false, pid: existing[0], agentReady: await this.agentReady(instance) };
    }

    await this.ensureInstanceDisplay(instance.display);
    await Promise.all([
      ensureDir(this.config.runtime.stateDir),
      ensureDir(instance.homeDir),
      ensureDir(instance.userDataDir),
      ensureDir(path.join(instance.homeDir, '.config')),
      ensureDir(path.join(instance.homeDir, '.cache')),
      ensureDir(path.join(instance.homeDir, '.local', 'share')),
    ]);
    await access(this.config.runtime.qq.command);
    await access(this.config.runtime.qq.agentEntry);

    const identity = this.processIdentity(instance);
    const args = [
      ...this.config.runtime.qq.args,
      `${INSTANCE_PREFIX}${identity}`,
      `--user-data-dir=${instance.userDataDir}`,
    ];
    const env = {
      DISPLAY: instance.display,
      HOME: instance.homeDir,
      XDG_CONFIG_HOME: path.join(instance.homeDir, '.config'),
      XDG_CACHE_HOME: path.join(instance.homeDir, '.cache'),
      XDG_DATA_HOME: path.join(instance.homeDir, '.local', 'share'),
      QQ_LOGIN_AGENT_ENTRY: this.config.runtime.qq.agentEntry,
      QQ_LOGIN_SOCKET: instance.socketPath,
      QQ_LOGIN_EXPECTED_UIN: instance.uin || '',
    };
    const pid = await this.spawn({
      command: this.config.runtime.qq.command,
      args,
      cwd: instance.homeDir,
      label: `LinuxQQ ${instance.uin ? `账号 ${instance.uin}` : `实例 ${instance.id}`}`,
    }, env, this.log);

    const processReady = await this.wait(async () => (await this.findPids(instance)).length > 0, 8_000);
    if (!processReady) {
      const message = `LinuxQQ ${instance.uin || instance.id} 启动后没有检测到主进程`;
      this.instanceErrors.set(instance.id, message);
      throw new Error(message);
    }
    const agentReady = await this.wait(() => this.agentReady(instance), this.config.runtime.qq.startupTimeoutMs, 300);
    if (!agentReady) {
      const message = `LinuxQQ ${instance.uin || instance.id} 已启动，但登录 Agent 未在限定时间内连接`;
      this.instanceErrors.set(instance.id, message);
      return { started: true, pid, agentReady: false, message };
    }
    this.instanceErrors.delete(instance.id);
    return { started: true, pid, agentReady: true };
  }

  async agentReady(instance) {
    try {
      await this.requestAgent(instance.socketPath, { action: 'status' }, { timeoutMs: 600 });
      return true;
    } catch {
      return false;
    }
  }

  async ensureInstanceDisplay(display) {
    if (this.displayStarts.has(display)) return this.displayStarts.get(display);
    const promise = this.ensureDisplay(this.config, this.log, display)
      .finally(() => this.displayStarts.delete(display));
    this.displayStarts.set(display, promise);
    return promise;
  }

  async statusFor(instance) {
    const pids = await this.findPids(instance);
    let agentState = null;
    let agentError = '';
    if (pids.length > 0) {
      try {
        const response = await this.requestAgent(instance.socketPath, { action: 'status' });
        agentState = response.state;
      } catch (error) {
        agentError = error instanceof Error ? error.message : String(error);
      }
    }
    const login = agentState ?? {
      instanceId: instance.id,
      pid: pids[0] ?? null,
      phase: pids.length > 0 ? 'agent_unavailable' : 'stopped',
      connected: false,
      qrcodeAvailable: false,
      qrcodeRevision: 0,
      quickLoginAccounts: [],
      account: null,
      capabilities: { logout: false },
      error: agentError || this.instanceErrors.get(instance.id) || '',
      updatedAt: null,
    };
    const detectedUin = String(login.account?.uin ?? '');
    const identityMismatch = Boolean(instance.uin && detectedUin && instance.uin !== detectedUin);
    return {
      id: instance.id,
      uin: instance.uin,
      enabled: instance.enabled,
      autostart: instance.autostart,
      process: { running: pids.length > 0, pid: pids[0] ?? null, duplicatePids: pids.slice(1) },
      login: {
        ...login,
        capabilities: { logout: login.capabilities?.logout === true },
        online: login.phase === 'online',
        expectedUin: instance.uin || null,
        identityMismatch,
        error: identityMismatch
          ? `扫码账号 ${detectedUin} 与此实例 QQ ${instance.uin} 不一致，请退出后使用正确账号扫码`
          : login.error,
      },
      startError: this.instanceErrors.get(instance.id) || null,
    };
  }

  async snapshot() {
    const [displayReady, qqAvailable, loader, instances] = await Promise.all([
      isDisplayReady(this.config.runtime.xvfb.display),
      isAccessible(this.config.runtime.qq.command),
      this.inspectLoader(this.config.runtime.qq.resourcesDir),
      Promise.all(this.config.instances.map(instance => this.statusFor(instance))),
    ]);
    return {
      runtime: {
        xvfb: { display: this.config.runtime.xvfb.display, ready: displayReady },
        qq: { command: this.config.runtime.qq.command, available: qqAvailable },
        loader,
      },
      instances,
      bootstrap: this.bootstrap,
      bootstrapError: this.bootstrapError || null,
      now: Date.now(),
    };
  }

  async refreshQrCode(id) {
    const instance = this.instance(id);
    return this.requestAgent(instance.socketPath, { action: 'refresh' }, { timeoutMs: AGENT_COMMAND_TIMEOUT_MS });
  }

  async quickLogin(id, uin) {
    const instance = this.instance(id);
    if (instance.uin && instance.uin !== String(uin)) {
      throw new Error(`此实例只允许登录 QQ ${instance.uin}`);
    }
    return this.requestAgent(instance.socketPath, { action: 'quickLogin', uin }, { timeoutMs: AGENT_COMMAND_TIMEOUT_MS });
  }

  async qrcode(id) {
    const instance = this.instance(id);
    return this.requestAgent(instance.socketPath, { action: 'qrcode' });
  }

  async logoutInstance(id) {
    const instance = this.instance(id);
    return this.requestAgent(instance.socketPath, { action: 'logout' }, { timeoutMs: AGENT_COMMAND_TIMEOUT_MS });
  }

  async stopInstance(id) {
    const instance = this.instance(id);
    if (this.starting.has(id)) throw new Error(`QQ 实例 ${instance.id} 正在启动，请稍后再停止`);
    if (this.stopping.has(id)) return this.stopping.get(id);
    const promise = this.stopInstanceInner(instance).finally(() => this.stopping.delete(id));
    this.stopping.set(id, promise);
    return promise;
  }

  async stopInstanceInner(instance) {
    const pids = await this.findPids(instance);
    if (pids.length === 0) return { stopped: true, signaledPids: [], remainingPids: [] };
    for (const pid of pids) {
      try {
        this.kill(pid, 'SIGTERM');
      } catch (error) {
        if (error?.code !== 'ESRCH') throw error;
      }
    }
    const stopped = await this.wait(async () => (await this.findPids(instance)).length === 0, 10_000, 250);
    const remainingPids = stopped ? [] : await this.findPids(instance);
    if (remainingPids.length > 0) {
      throw new Error(`QQ 实例 ${instance.id} 未在 10 秒内退出；为避免误杀，没有自动发送 SIGKILL`);
    }
    this.instanceErrors.delete(instance.id);
    return { stopped: true, signaledPids: pids, remainingPids };
  }

  async addInstance({ uin, autostart = false, startNow = false } = {}) {
    if (!this.configStore) throw new Error('当前服务未启用网页配置写入');
    const wantedUin = String(uin ?? '').trim();
    if (!/^[1-9]\d{4,19}$/.test(wantedUin)) throw new Error('请输入有效 QQ 号');
    const statuses = await Promise.all(this.config.instances.map(instance => this.statusFor(instance)));
    if (statuses.some(status => String(status.login.account?.uin ?? '') === wantedUin)) {
      throw new Error(`QQ ${wantedUin} 已由现有实例管理`);
    }
    const instance = await this.configStore.addInstance({ uin: wantedUin, autostart });
    let start = null;
    if (startNow) {
      try {
        start = await this.startInstance(instance.id);
      } catch (error) {
        start = { started: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    return { instance, start };
  }

  async updateInstance(id, patch) {
    if (!this.configStore) throw new Error('当前服务未启用网页配置写入');
    this.instance(id);
    return this.configStore.updateInstance(id, patch);
  }

  async removeInstance(id) {
    if (!this.configStore) throw new Error('当前服务未启用网页配置写入');
    const instance = this.instance(id);
    const pids = await this.findPids(instance);
    if (pids.length > 0) throw new Error(`请先停止 QQ 实例 ${id}，再移除实例`);
    this.instanceErrors.delete(id);
    return this.configStore.removeInstance(id);
  }

  settings() {
    if (!this.configStore) throw new Error('当前服务未启用网页配置写入');
    return this.configStore.settings();
  }

  async updateSettings(patch) {
    if (!this.configStore) throw new Error('当前服务未启用网页配置写入');
    return this.configStore.updateSettings(patch);
  }

  async bootstrapRuntime() {
    if (process.platform !== 'linux') throw new Error('自动启动仅支持 Linux；本地开发请设置 runtime.autostart=false');
    const result = { display: 'existing', instances: [] };
    try {
      await ensureDir(this.config.runtime.stateDir);
      result.display = await this.ensureInstanceDisplay(this.config.runtime.xvfb.display);
      const loader = await this.inspectLoader(this.config.runtime.qq.resourcesDir);
      if (!loader.installed) throw new Error(`${loader.message}；请先执行 loader install`);
      for (const instance of this.config.instances.filter(item => item.enabled && item.autostart)) {
        result.instances.push({ id: instance.id, ...await this.startInstance(instance.id) });
      }
      this.bootstrap = result;
      this.bootstrapError = '';
      return result;
    } catch (error) {
      this.bootstrapError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }
}
