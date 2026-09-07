import { readFile } from 'node:fs/promises';
import path from 'node:path';

const HASH_RE = /^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/;
const INSTANCE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const UIN_RE = /^[1-9]\d{4,19}$/;

export const DEFAULT_CONFIG = Object.freeze({
  listen: { host: '127.0.0.1', port: 5100 },
  auth: { password: '', sessionTtlMinutes: 60, secureCookie: false },
  runtime: {
    autostart: true,
    stateDir: './state',
    xvfb: {
      display: ':1',
      command: 'Xvfb',
      args: [':1', '-screen', '0', '1280x720x24', '-nolisten', 'tcp'],
    },
    qq: {
      command: '/opt/QQ/qq',
      resourcesDir: '/opt/QQ/resources/app',
      agentEntry: './src/qq-agent.cjs',
      args: ['--no-sandbox'],
      startupTimeoutMs: 15_000,
    },
  },
  management: {
    instanceRoot: './data/instances',
    maxInstances: 16,
  },
  instances: [],
});

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
  return value;
}

function text(value, label, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) throw new Error(`${label} 必须是字符串`);
  return value.trim();
}

function integer(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} 必须是 ${min} 到 ${max} 之间的整数`);
  }
  return value;
}

function stringArray(value, label) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`${label} 必须是字符串数组`);
  }
  return [...value];
}

function resolvePath(value, label, configDir) {
  const configured = text(value, label);
  return path.isAbsolute(configured) ? path.normalize(configured) : path.resolve(configDir, configured);
}

function display(value, label) {
  const configured = text(value, label);
  if (!/^:\d{1,4}$/.test(configured)) throw new Error(`${label} 必须是类似 :1 的 X11 显示号`);
  return configured;
}

function assertUnique(instances, select, label) {
  const seen = new Map();
  for (const instance of instances) {
    const value = select(instance);
    if (value === null || value === undefined || value === '') continue;
    const previous = seen.get(value);
    if (previous) throw new Error(`${label} 冲突：实例 ${previous} 与 ${instance.id} 都使用 ${value}`);
    seen.set(value, instance.id);
  }
}

function normalizeInstance(raw, index, configDir, defaultDisplay, stateDir, instanceRoot) {
  const item = object(raw, `instances[${index}]`);
  const configuredUin = item.uin === undefined ? '' : text(item.uin, `instances[${index}].uin`);
  if (configuredUin && !UIN_RE.test(configuredUin)) {
    throw new Error(`instances[${index}].uin 必须是有效 QQ 号`);
  }
  const id = item.id === undefined
    ? configuredUin
    : text(item.id, `instances[${index}].id`);
  if (!INSTANCE_ID_RE.test(id)) {
    throw new Error(`instances[${index}].id 只能包含小写字母、数字、下划线和连字符，且长度不超过 32`);
  }
  const uin = configuredUin || (UIN_RE.test(id) ? id : '');
  if (UIN_RE.test(id) && uin !== id) {
    throw new Error(`instances[${index}] 使用 QQ 号作为 id 时，id 与 uin 必须一致`);
  }

  const homeDir = resolvePath(
    item.homeDir ?? path.join(instanceRoot, id, 'home'),
    `instances[${index}].homeDir`,
    configDir,
  );
  const userDataDir = resolvePath(
    item.userDataDir ?? path.join(instanceRoot, id, 'electron'),
    `instances[${index}].userDataDir`,
    configDir,
  );
  if (homeDir === path.parse(homeDir).root) throw new Error(`instances[${index}].homeDir 不能是文件系统根目录`);
  if (userDataDir === path.parse(userDataDir).root) throw new Error(`instances[${index}].userDataDir 不能是文件系统根目录`);

  return {
    id,
    uin,
    enabled: item.enabled !== false,
    autostart: item.autostart === true,
    homeDir,
    userDataDir,
    display: display(item.display ?? defaultDisplay, `instances[${index}].display`),
    socketPath: path.join(stateDir, `${id}.sock`),
  };
}

export function normalizeConfig(raw, configDir = process.cwd()) {
  const root = object(raw, '配置');
  const listen = object(root.listen, 'listen');
  const auth = object(root.auth, 'auth');
  const runtime = object(root.runtime, 'runtime');
  const xvfb = object(runtime.xvfb, 'runtime.xvfb');
  const qq = object(runtime.qq, 'runtime.qq');
  const management = root.management === undefined ? {} : object(root.management, 'management');

  const password = typeof auth.password === 'string' ? auth.password : '';
  const passwordHash = typeof auth.passwordHash === 'string' ? auth.passwordHash : '';
  if (password && passwordHash) throw new Error('auth.password 与 auth.passwordHash 只能配置一个');
  if (password && (password.length < 12 || password.length > 256)) {
    throw new Error('auth.password 必须是 12 到 256 个字符的固定密码');
  }
  if (!password && !HASH_RE.test(passwordHash)) {
    throw new Error('请配置 auth.password，或保留有效的旧版 auth.passwordHash');
  }

  const stateDir = resolvePath(runtime.stateDir, 'runtime.stateDir', configDir);
  if (stateDir === path.parse(stateDir).root) throw new Error('runtime.stateDir 不能是文件系统根目录');
  const defaultDisplay = display(xvfb.display, 'runtime.xvfb.display');
  const instanceRoot = resolvePath(
    management.instanceRoot ?? './data/instances',
    'management.instanceRoot',
    configDir,
  );
  if (instanceRoot === path.parse(instanceRoot).root) {
    throw new Error('management.instanceRoot 不能是文件系统根目录');
  }
  const rawInstances = root.instances === undefined ? [] : root.instances;
  if (!Array.isArray(rawInstances)) throw new Error('instances 必须是数组');
  const instances = rawInstances.map((item, index) => normalizeInstance(
    item,
    index,
    configDir,
    defaultDisplay,
    stateDir,
    instanceRoot,
  ));

  assertUnique(instances, instance => instance.id, '实例 ID');
  assertUnique(instances, instance => instance.uin || null, 'QQ 号');
  assertUnique(instances, instance => path.resolve(instance.homeDir).toLowerCase(), 'QQ HOME');
  assertUnique(instances, instance => path.resolve(instance.userDataDir).toLowerCase(), 'Electron 用户目录');
  assertUnique(instances, instance => path.resolve(instance.socketPath).toLowerCase(), '登录 Socket');

  const qqArgs = stringArray(qq.args, 'runtime.qq.args');
  if (qqArgs.some(arg => [
    '--qq-login-instance=',
    '--snowluma-instance=',
    '--user-data-dir=',
  ].some(prefix => arg.startsWith(prefix)))) {
    throw new Error('runtime.qq.args 不要手动配置实例标识或 --user-data-dir；它们由每个实例自动生成');
  }

  return {
    listen: {
      host: text(listen.host, 'listen.host'),
      port: integer(listen.port, 'listen.port', 1, 65_535),
    },
    auth: {
      password,
      passwordHash,
      sessionTtlMinutes: integer(auth.sessionTtlMinutes ?? 60, 'auth.sessionTtlMinutes', 5, 1_440),
      secureCookie: auth.secureCookie === true,
    },
    runtime: {
      autostart: runtime.autostart !== false,
      stateDir,
      xvfb: {
        display: defaultDisplay,
        command: text(xvfb.command, 'runtime.xvfb.command'),
        args: stringArray(xvfb.args, 'runtime.xvfb.args'),
      },
      qq: {
        command: resolvePath(qq.command, 'runtime.qq.command', configDir),
        resourcesDir: resolvePath(qq.resourcesDir, 'runtime.qq.resourcesDir', configDir),
        agentEntry: resolvePath(qq.agentEntry, 'runtime.qq.agentEntry', configDir),
        args: qqArgs,
        startupTimeoutMs: integer(qq.startupTimeoutMs ?? 15_000, 'runtime.qq.startupTimeoutMs', 2_000, 120_000),
      },
    },
    management: {
      instanceRoot,
      maxInstances: integer(management.maxInstances ?? 16, 'management.maxInstances', 1, 64),
    },
    instances,
  };
}

export async function loadConfig(configPath) {
  const absolute = path.resolve(configPath);
  let raw;
  try {
    raw = JSON.parse(await readFile(absolute, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`配置文件不存在：${absolute}；请先运行 node src/cli.mjs init ./config.json`);
    }
    if (error instanceof SyntaxError) throw new Error(`配置文件不是有效 JSON：${absolute}`);
    throw error;
  }
  return normalizeConfig(raw, path.dirname(absolute));
}

export { INSTANCE_ID_RE, UIN_RE };
