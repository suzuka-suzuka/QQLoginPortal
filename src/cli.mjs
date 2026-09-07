import { access, chmod, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { generatePassword } from './auth.mjs';
import { DEFAULT_CONFIG, loadConfig } from './config.mjs';
import { inspectLoader, installLoader, restoreLoader } from './loader-install.mjs';
import { QQInstanceManager } from './runtime.mjs';

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function initConfig(file) {
  const target = path.resolve(file);
  if (await exists(target)) throw new Error(`拒绝覆盖已有配置：${target}`);
  const config = structuredClone(DEFAULT_CONFIG);
  config.auth.password = generatePassword();
  await writeFile(target, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  if (process.platform !== 'win32') await chmod(target, 0o600);
  console.log(`配置已创建：${target}`);
  console.log('固定访问密码已写入 auth.password；请保持配置文件权限为 0600。');
}

function printLoaderStatus(status) {
  console.log(`${status.installed ? '已安装' : '未安装'}：${status.message}`);
  if (status.originalMain) console.log(`QQ 原始入口：${status.originalMain}`);
}

async function waitFor(check, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return check();
}

export async function probeKernel(config, {
  platform = process.platform,
  managerFactory = probeConfig => new QQInstanceManager(probeConfig),
  killProcess = (pid, signal) => process.kill(pid, signal),
  removePath = rm,
  output = message => console.log(message),
  errorOutput = message => console.error(message),
} = {}) {
  if (platform !== 'linux') throw new Error('QQ 内核探针只支持在 LinuxQQ 服务器上运行');
  const probeRoot = path.resolve(config.runtime.stateDir, '.kernel-probe');
  const relative = path.relative(config.runtime.stateDir, probeRoot);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('探针目录必须位于 runtime.stateDir 内');
  const instance = {
    id: 'kernel-probe',
    enabled: true,
    autostart: false,
    uin: '',
    homeDir: path.join(probeRoot, 'home'),
    userDataDir: path.join(probeRoot, 'electron'),
    display: config.runtime.xvfb.display,
    socketPath: path.join(config.runtime.stateDir, 'kernel-probe.sock'),
  };
  const probeConfig = { ...config, instances: [instance] };
  const manager = managerFactory(probeConfig);
  let cleanupAuthorized = false;
  try {
    if ((await manager.findPids(instance)).length > 0) {
      throw new Error('检测到遗留的 kernel-probe 主进程；请先核对其 PID，探针不会接管或结束它');
    }
    // From this point on, a start attempt may have spawned QQ even if it throws
    // before returning. Cleanup is still limited to this exact instance flag.
    cleanupAuthorized = true;
    await manager.startInstance(instance.id);
    const state = await waitFor(async () => {
      const current = await manager.statusFor(instance);
      if (current.login.qrcodeAvailable) return current;
      if (['failed', 'disconnected'].includes(current.login.phase)) {
        throw new Error(current.login.error || `QQ 登录内核进入 ${current.login.phase}`);
      }
      return null;
    }, 45_000);
    if (!state?.login.qrcodeAvailable) throw new Error('45 秒内没有收到 QQ 内核二维码');
    const response = await manager.qrcode(instance.id);
    const bytes = Buffer.from(response.qrcode.base64, 'base64');
    if (bytes.length === 0) throw new Error('QQ 内核二维码为空');
    output(JSON.stringify({
      success: true,
      phase: state.login.phase,
      qrcodeMimeType: response.qrcode.mimeType,
      qrcodeBytes: bytes.length,
      quickLoginAccounts: state.login.quickLoginAccounts.length,
    }));
  } finally {
    if (cleanupAuthorized) {
      const pids = await manager.findPids(instance);
      for (const pid of pids) {
        try { killProcess(pid, 'SIGTERM'); } catch { /* process already exited */ }
      }
      const stopped = await waitFor(async () => (await manager.findPids(instance)).length === 0, 10_000);
      if (!stopped) {
        errorOutput('QQ 内核探针进程未在 10 秒内退出；为避免误杀，不会自动使用 SIGKILL，也不会删除探针数据。');
      } else {
        await Promise.all([
          removePath(probeRoot, { recursive: true, force: true }),
          removePath(instance.socketPath, { force: true }),
        ]);
      }
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  const [command, file = './config.json'] = argv;
  if (command === 'init') {
    await initConfig(file);
    return;
  }
  const config = await loadConfig(file);
  if (command === 'check') {
    console.log(`配置有效：监听 ${config.listen.host}:${config.listen.port}，QQ 实例 ${config.instances.length} 个`);
    console.log(`QQ resources：${config.runtime.qq.resourcesDir}`);
    printLoaderStatus(await inspectLoader(config.runtime.qq.resourcesDir));
    return;
  }
  if (command === 'loader-status') {
    printLoaderStatus(await inspectLoader(config.runtime.qq.resourcesDir));
    return;
  }
  if (command === 'loader-install') {
    const result = await installLoader(config.runtime.qq.resourcesDir);
    printLoaderStatus(result);
    if (result.backupCreated) {
      console.log('已创建原始 package.json 备份；QQ 更新后需要重新检查加载器。');
    } else if (result.refreshedLoader) {
      console.log('已刷新登录加载器；原始 package.json 备份未改动。');
    } else {
      console.log('文件未改动。');
    }
    return;
  }
  if (command === 'loader-restore') {
    const result = await restoreLoader(config.runtime.qq.resourcesDir);
    console.log(result.message);
    return;
  }
  if (command === 'probe-kernel') {
    await probeKernel(config);
    return;
  }
  throw new Error('用法：node src/cli.mjs <init|check|loader-status|loader-install|loader-restore|probe-kernel> [config.json]');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
