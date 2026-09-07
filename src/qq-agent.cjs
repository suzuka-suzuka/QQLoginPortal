'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const AGENT_SYMBOL = Symbol.for('qqLoginPortal.agent');
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_QR_BYTES = 1024 * 1024;
const UIN_RE = /^[1-9]\d{4,19}$/;

class QQLoginListener {
  onLoginConnected() {}
  onLoginDisConnected() {}
  onLoginConnecting() {}
  onQRCodeGetPicture() {}
  onQRCodeLoginPollingStarted() {}
  onQRCodeSessionUserScaned() {}
  onQRCodeLoginSucceed() {}
  onQRCodeSessionFailed() {}
  onLoginFailed() {}
  onLogoutSucceed() {}
  onLogoutFailed() {}
  onUserLoggedIn() {}
  onQRCodeSessionQuickLoginFailed() {}
  onPasswordLoginFailed() {}
  OnConfirmUnusualDeviceFailed() {}
  onQQLoginNumLimited() {}
  onLoginState() {}
  onLoginRecordUpdate() {}
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function parseQrImage(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/_=-]+)$/i.exec(value);
  if (!match && /^data:/i.test(value)) return null;
  const mimeType = match?.[1]?.toLowerCase() ?? 'image/png';
  const encoded = match?.[2] ?? value;
  if (!/^image\/(?:png|jpeg|webp)$/.test(mimeType)) return null;
  try {
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length === 0 || bytes.length > MAX_QR_BYTES) return null;
    return { mimeType, base64: bytes.toString('base64') };
  } catch {
    return null;
  }
}

function normalizeQuickLoginAccounts(result) {
  const list = Array.isArray(result?.LocalLoginInfoList) ? result.LocalLoginInfoList : [];
  return list
    .filter(item => item?.isQuickLogin === true && UIN_RE.test(String(item.uin ?? '')))
    .map(item => ({
      uin: String(item.uin),
      nickname: typeof item.nickName === 'string' ? item.nickName : '',
      autoLogin: item.isAutoLogin === true,
    }));
}

function createQQLoginController(loginService, {
  instanceId,
  expectedUin = '',
  pid = process.pid,
  now = () => Date.now(),
  schedule = (callback, delay) => setTimeout(callback, delay),
} = {}) {
  if (!loginService || typeof loginService.addKernelLoginListener !== 'function') {
    throw new Error('QQ wrapper 没有提供 NodeIKernelLoginService');
  }
  if (typeof instanceId !== 'string' || !instanceId) throw new Error('instanceId 不能为空');
  if (expectedUin && !UIN_RE.test(expectedUin)) throw new Error('expectedUin 必须是有效 QQ 号');

  let pendingLogoutState = null;

  const state = {
    instanceId,
    pid,
    phase: 'initializing',
    connected: false,
    qrcodeAvailable: false,
    qrcodeRevision: 0,
    qrcodeMimeType: '',
    qrcodeBase64: '',
    qrcodeUrl: '',
    quickLoginAccounts: [],
    account: null,
    error: '',
    updatedAt: now(),
  };

  const update = patch => {
    Object.assign(state, patch, { updatedAt: now() });
  };

  const publicSnapshot = () => ({
    instanceId: state.instanceId,
    pid: state.pid,
    phase: state.phase,
    connected: state.connected,
    qrcodeAvailable: state.qrcodeAvailable,
    qrcodeRevision: state.qrcodeRevision,
    quickLoginAccounts: state.quickLoginAccounts.map(account => ({ ...account })),
    account: state.account ? { ...state.account } : null,
    capabilities: {
      logout: typeof loginService.offline === 'function',
    },
    error: state.error,
    updatedAt: state.updatedAt,
  });

  const refreshHistory = async () => {
    if (typeof loginService.getLoginList !== 'function') return;
    try {
      const result = await loginService.getLoginList();
      update({ quickLoginAccounts: normalizeQuickLoginAccounts(result) });
    } catch (error) {
      update({ error: `读取快速登录列表失败：${errorText(error)}` });
    }
  };

  const requestQrCode = () => {
    if (typeof loginService.getQRCodePicture !== 'function') throw new Error('当前 QQ 不支持获取登录二维码');
    update({ phase: 'refreshing', error: '' });
    const accepted = loginService.getQRCodePicture();
    if (accepted === false) update({ phase: 'connected', error: 'QQ 暂未接受二维码刷新请求' });
    return accepted !== false;
  };

  const quickLogin = async uin => {
    if (!UIN_RE.test(String(uin ?? ''))) throw new Error('QQ 号格式无效');
    if (typeof loginService.quickLoginWithUin !== 'function') throw new Error('当前 QQ 不支持快速登录');
    update({ phase: 'quick_login', error: '' });
    const result = await loginService.quickLoginWithUin(String(uin));
    const success = String(result?.result ?? '') === '0' && !result?.loginErrorInfo?.errMsg;
    if (!success) {
      const message = result?.loginErrorInfo?.errMsg || `快速登录失败，错误码：${String(result?.result ?? 'unknown')}`;
      update({ phase: 'failed', error: message });
      return { success: false, message };
    }
    return { success: true, message: '' };
  };

  const logout = async () => {
    if (typeof loginService.offline !== 'function') throw new Error('当前 QQ 不支持内核退出登录');
    update({ phase: 'logging_out', error: '' });
    try {
      const result = await Promise.resolve(loginService.offline());
      if (result === false) {
        update({ phase: 'failed', error: 'QQ 暂未接受退出登录请求' });
        return { accepted: false };
      }
      return { accepted: true };
    } catch (error) {
      update({ phase: 'failed', error: `退出登录失败：${errorText(error)}` });
      throw error;
    }
  };

  const listener = new QQLoginListener();
  listener.onLoginConnecting = () => update({ phase: 'connecting', connected: false, error: '' });
  listener.onLoginConnected = () => {
    update({ phase: 'connected', connected: true, error: '' });
    void refreshHistory();
    const timer = schedule(() => {
      try { requestQrCode(); } catch (error) { update({ phase: 'failed', error: errorText(error) }); }
    }, 100);
    timer?.unref?.();
  };
  listener.onLoginDisConnected = (...args) => update({
    phase: 'disconnected',
    connected: false,
    error: args.length > 0 ? `登录服务已断开：${args.map(errorText).join(' ')}` : '登录服务已断开',
  });
  listener.onQRCodeLoginPollingStarted = () => update({ phase: 'waiting_scan', connected: true, error: '' });
  listener.onQRCodeGetPicture = payload => {
    const image = parseQrImage(payload?.pngBase64QrcodeData);
    update({
      phase: 'waiting_scan',
      connected: true,
      qrcodeAvailable: image !== null,
      qrcodeRevision: state.qrcodeRevision + 1,
      qrcodeMimeType: image?.mimeType ?? '',
      qrcodeBase64: image?.base64 ?? '',
      qrcodeUrl: typeof payload?.qrcodeUrl === 'string' ? payload.qrcodeUrl : '',
      error: image ? '' : 'QQ 已返回二维码地址，但二维码图片数据无效',
    });
  };
  listener.onQRCodeSessionUserScaned = () => update({ phase: 'scanned', error: '' });
  listener.onQRCodeLoginSucceed = result => {
    const account = {
      uin: String(result?.uin ?? result?.account ?? ''),
      uid: typeof result?.uid === 'string' ? result.uid : '',
      nickname: typeof result?.nickName === 'string' ? result.nickName : '',
    };
    update({
      phase: 'online',
      connected: true,
      qrcodeAvailable: false,
      qrcodeBase64: '',
      qrcodeUrl: '',
      account,
      error: '',
    });
    if (expectedUin && account.uin && account.uin !== expectedUin) {
      pendingLogoutState = {
        phase: 'account_mismatch',
        error: `扫码账号 ${account.uin} 与实例 QQ ${expectedUin} 不一致，已自动退出`,
      };
      const timer = schedule(() => {
        void logout().catch(() => {});
      }, 0);
      timer?.unref?.();
    }
  };
  listener.onQRCodeSessionFailed = (errorType, errorCode) => {
    const expired = Number(errorType) === 1 && Number(errorCode) === 3;
    update({
      phase: expired ? 'expired' : 'failed',
      qrcodeAvailable: false,
      error: expired ? '二维码已过期，请刷新' : `二维码登录失败（${errorType}/${errorCode}）`,
    });
  };
  listener.onLoginFailed = (...args) => update({ phase: 'failed', error: `登录失败：${args.map(errorText).join(' ')}` });
  listener.onPasswordLoginFailed = (...args) => update({ phase: 'failed', error: `登录失败：${args.map(errorText).join(' ')}` });
  listener.onQRCodeSessionQuickLoginFailed = (...args) => update({ phase: 'failed', error: `快速登录失败：${args.map(errorText).join(' ')}` });
  listener.onLogoutSucceed = () => {
    const nextState = pendingLogoutState ?? { phase: 'connected', error: '' };
    pendingLogoutState = null;
    update({
      ...nextState,
      connected: true,
      qrcodeAvailable: false,
      qrcodeBase64: '',
      qrcodeUrl: '',
      account: null,
    });
    void refreshHistory();
  };
  listener.onLogoutFailed = (...args) => {
    pendingLogoutState = null;
    update({ phase: 'failed', error: `退出登录失败：${args.map(errorText).join(' ')}` });
  };
  listener.onUserLoggedIn = userId => update({
    phase: 'online',
    connected: true,
    account: state.account ?? { uin: String(userId ?? ''), uid: '', nickname: '' },
    error: '',
  });

  const listenerId = loginService.addKernelLoginListener(listener);
  update({ phase: 'connecting' });
  void refreshHistory();

  return {
    listener,
    listenerId,
    publicSnapshot,
    getQrCode: () => state.qrcodeAvailable ? {
      mimeType: state.qrcodeMimeType,
      base64: state.qrcodeBase64,
      revision: state.qrcodeRevision,
    } : null,
    requestQrCode,
    quickLogin,
    logout,
    dispose: () => {
      if (typeof loginService.removeKernelLoginListener === 'function') {
        try { loginService.removeKernelLoginListener(listenerId); } catch { /* QQ may already be shutting down. */ }
      }
    },
  };
}

function prepareSocketPath(socketPath) {
  if (process.platform !== 'linux') throw new Error('QQ 登录 Agent 的 Unix Socket 仅支持 Linux');
  if (Buffer.byteLength(socketPath) > 100) throw new Error(`Unix Socket 路径过长：${socketPath}`);
  const parent = path.dirname(socketPath);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  let stat;
  try { stat = fs.lstatSync(socketPath); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (!stat) return;
  if (!stat.isSocket()) throw new Error(`拒绝覆盖非 Socket 文件：${socketPath}`);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`拒绝删除其他用户拥有的 Socket：${socketPath}`);
  }
  fs.unlinkSync(socketPath);
}

function startAgentServer(controller, socketPath) {
  prepareSocketPath(socketPath);
  const server = net.createServer(socket => {
    const chunks = [];
    let size = 0;
    let handled = false;
    socket.on('data', chunk => {
      if (handled) return;
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        handled = true;
        socket.end(`${JSON.stringify({ ok: false, error: '请求内容过大' })}\n`);
        return;
      }
      chunks.push(chunk);
      const all = Buffer.concat(chunks);
      const newline = all.indexOf(0x0a);
      if (newline < 0) return;
      handled = true;
      void handleAgentRequest(controller, all.subarray(0, newline).toString('utf8'))
        .then(result => socket.end(`${JSON.stringify({ ok: true, ...result })}\n`))
        .catch(error => socket.end(`${JSON.stringify({ ok: false, error: errorText(error) })}\n`));
    });
    socket.setTimeout(5_000, () => socket.destroy());
  });
  server.on('error', error => console.error('[QQ Login Portal] Socket 服务错误：', error));
  server.listen(socketPath, () => {
    try { fs.chmodSync(socketPath, 0o600); } catch (error) {
      console.error('[QQ Login Portal] 无法收紧 Socket 权限：', error);
    }
    console.log(`[QQ Login Portal] 实例 ${controller.publicSnapshot().instanceId} 已连接 QQ 登录内核`);
  });
  return server;
}

async function handleAgentRequest(controller, line) {
  let request;
  try { request = JSON.parse(line || '{}'); } catch { throw new Error('请求不是有效 JSON'); }
  if (request.action === 'status') return { state: controller.publicSnapshot() };
  if (request.action === 'qrcode') {
    const qrcode = controller.getQrCode();
    if (!qrcode) throw new Error('当前没有可用二维码');
    return { qrcode };
  }
  if (request.action === 'refresh') {
    const accepted = controller.requestQrCode();
    return { accepted, state: controller.publicSnapshot() };
  }
  if (request.action === 'quickLogin') {
    const result = await controller.quickLogin(request.uin);
    return { result, state: controller.publicSnapshot() };
  }
  if (request.action === 'logout') {
    const result = await controller.logout();
    return { result, state: controller.publicSnapshot() };
  }
  throw new Error('不支持的操作');
}

function attachQQLoginAgent({
  wrapper,
  instanceId,
  socketPath,
  expectedUin = process.env.QQ_LOGIN_EXPECTED_UIN || '',
}) {
  const existing = globalThis[AGENT_SYMBOL];
  if (existing) return existing.controller;
  if (!wrapper?.NodeIKernelLoginService || typeof wrapper.NodeIKernelLoginService.get !== 'function') {
    throw new Error('QQ wrapper 未暴露 NodeIKernelLoginService.get()');
  }
  const loginService = wrapper.NodeIKernelLoginService.get();
  const controller = createQQLoginController(loginService, { instanceId, expectedUin });
  const server = startAgentServer(controller, socketPath);
  const cleanup = () => {
    controller.dispose();
    try { server.close(); } catch { /* process is already exiting */ }
    try {
      const stat = fs.lstatSync(socketPath);
      if (stat.isSocket() && (typeof process.getuid !== 'function' || stat.uid === process.getuid())) fs.unlinkSync(socketPath);
    } catch { /* socket was already removed */ }
  };
  process.once('exit', cleanup);
  globalThis[AGENT_SYMBOL] = { controller, server };
  return controller;
}

module.exports = {
  attachQQLoginAgent,
  createQQLoginController,
  handleAgentRequest,
  parseQrImage,
};
