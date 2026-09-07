'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LOADER_FILE = 'qq-login-portal-loader.cjs';
const METADATA_FILE = 'qq-login-portal-loader.json';
const INSTANCE_PREFIX = '--qq-login-instance=';
const LEGACY_INSTANCE_PREFIX = '--snowluma-instance=';

const loaderDir = __dirname;
const metadataPath = path.join(loaderDir, METADATA_FILE);
const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));

if (metadata.schemaVersion !== 1 || typeof metadata.originalMain !== 'string' || !metadata.originalMain) {
  throw new Error(`[QQ Login Portal] ${METADATA_FILE} 无效，拒绝启动以免递归加载 QQ`);
}

const originalEntry = path.resolve(loaderDir, metadata.originalMain);
if (path.basename(originalEntry).toLowerCase() === LOADER_FILE) {
  throw new Error('[QQ Login Portal] originalMain 指向登录加载器自身');
}

const instanceArg = process.argv.find(arg => typeof arg === 'string' && (
  arg.startsWith(INSTANCE_PREFIX) || arg.startsWith(LEGACY_INSTANCE_PREFIX)
));
const instanceId = instanceArg?.startsWith(INSTANCE_PREFIX)
  ? instanceArg.slice(INSTANCE_PREFIX.length)
  : instanceArg?.slice(LEGACY_INSTANCE_PREFIX.length) ?? '';

if (instanceId) {
  installLoginServiceTap(instanceId);
}

require(originalEntry);

function installLoginServiceTap(id) {
  const agentEntry = process.env.QQ_LOGIN_AGENT_ENTRY;
  const socketPath = process.env.QQ_LOGIN_SOCKET;
  if (!agentEntry || !path.isAbsolute(agentEntry) || !socketPath || !path.isAbsolute(socketPath)) {
    console.error('[QQ Login Portal] 缺少绝对路径 QQ_LOGIN_AGENT_ENTRY 或 QQ_LOGIN_SOCKET；QQ 将继续启动，但网页无法取得二维码');
    return;
  }

  const originalDlopen = process.dlopen;
  let attached = false;
  process.dlopen = function qqLoginPortalDlopen(module, filename) {
    const result = Reflect.apply(originalDlopen, process, arguments);
    if (attached || path.basename(String(filename)).toLowerCase() !== 'wrapper.node') return result;
    attached = true;

    try {
      const agent = require(agentEntry);
      if (!agent || typeof agent.attachQQLoginAgent !== 'function') {
        throw new Error('agent 未导出 attachQQLoginAgent');
      }
      agent.attachQQLoginAgent({
        wrapper: module.exports,
        instanceId: id,
        socketPath,
        expectedUin: process.env.QQ_LOGIN_EXPECTED_UIN || '',
      });
    } catch (error) {
      console.error('[QQ Login Portal] 登录桥加载失败；QQ 将继续运行：', error);
    }
    return result;
  };
}
