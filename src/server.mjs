import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';
import { ConfigFileStore } from './config-store.mjs';
import { createPortalServer } from './portal.mjs';
import { QQInstanceManager } from './runtime.mjs';

function configArg(argv) {
  const index = argv.indexOf('--config');
  return index >= 0 && argv[index + 1] ? argv[index + 1] : './config.json';
}

export async function main(argv = process.argv.slice(2)) {
  const configPath = configArg(argv);
  const config = await loadConfig(configPath);
  const configStore = new ConfigFileStore(configPath, config);
  const instanceManager = new QQInstanceManager(config, { configStore });

  if (config.runtime.autostart) {
    try {
      await instanceManager.bootstrapRuntime();
    } catch (error) {
      console.error(`[运行环境] ${error instanceof Error ? error.message : String(error)}`);
      console.error('[运行环境] 登录面板仍会启动，请在页面中查看状态并检查服务器日志。');
    }
  }

  const server = createPortalServer({ config, instanceManager });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.listen.port, config.listen.host, resolve);
  });
  console.log(`QQ Login Portal 已监听 http://${config.listen.host}:${config.listen.port}`);
  if (config.listen.host !== '127.0.0.1' && config.listen.host !== '::1' && !config.auth.secureCookie) {
    console.warn('警告：当前监听非本机地址且未启用 Secure Cookie。请改用 SSH 隧道，或在 HTTPS 反向代理后启用 secureCookie。');
  }
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
