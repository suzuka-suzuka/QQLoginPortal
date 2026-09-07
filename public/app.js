/* global document */

const loginPanel = document.querySelector('#login-panel');
const portalPanel = document.querySelector('#portal-panel');
const topActions = document.querySelector('#top-actions');
const loginForm = document.querySelector('#login-form');
const loginError = document.querySelector('#login-error');
const runtimeError = document.querySelector('#runtime-error');
const instancesGrid = document.querySelector('#instances-grid');
const emptyState = document.querySelector('#empty-state');
const logoutButton = document.querySelector('#logout-button');
const addButton = document.querySelector('#add-instance-button');
const settingsButton = document.querySelector('#settings-button');
const addDialog = document.querySelector('#add-dialog');
const addForm = document.querySelector('#add-form');
const addError = document.querySelector('#add-error');
const settingsDialog = document.querySelector('#settings-dialog');
const settingsForm = document.querySelector('#settings-form');
const settingsError = document.querySelector('#settings-error');
const confirmDialog = document.querySelector('#confirm-dialog');
const confirmTitle = document.querySelector('#confirm-title');
const confirmMessage = document.querySelector('#confirm-message');
const confirmAccept = document.querySelector('#confirm-accept');
const confirmCancel = document.querySelector('#confirm-cancel');
const toast = document.querySelector('#toast');
const cards = new Map();
let refreshTimer;
let refreshRunning = false;
let currentStatus = null;
let confirmResolver = null;
let toastTimer;

const phaseLabels = {
  stopped: '尚未启动',
  agent_unavailable: '登录桥未连接',
  initializing: '正在初始化',
  connecting: '正在连接登录服务',
  connected: '等待登录',
  refreshing: '正在生成二维码',
  waiting_scan: '等待扫码',
  scanned: '已扫码，请在手机确认',
  quick_login: '正在快速登录',
  online: '已登录',
  account_mismatch: '账号不匹配',
  logging_out: '正在退出 QQ',
  expired: '二维码已过期',
  failed: '操作失败',
  disconnected: '登录服务已断开',
};

async function api(path, options) {
  const response = await fetch(path, {
    cache: 'no-store',
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || `请求失败（${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function closeDialogs() {
  for (const dialog of [addDialog, settingsDialog, confirmDialog]) {
    if (dialog.open) dialog.close();
  }
}

function showLogin() {
  clearTimeout(refreshTimer);
  closeDialogs();
  loginPanel.hidden = false;
  portalPanel.hidden = true;
  topActions.hidden = true;
  document.querySelector('#password').focus();
}

function showPortal() {
  loginPanel.hidden = true;
  portalPanel.hidden = false;
  topActions.hidden = false;
  void refreshStatus();
}

function showToast(message, type = 'success') {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.className = `toast${type === 'error' ? ' error' : ''}`;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 4_000);
}

function setGlobalStatus(name, ready, detail, warning = false) {
  const dot = document.querySelector(`#${name}-dot`);
  dot.className = `status-dot${ready ? ' ok' : ''}${warning ? ' warn' : ''}`;
  document.querySelector(`#${name}-status`).textContent = detail;
}

function instanceIdentity(instance) {
  return String(instance.uin || instance.login.account?.uin || '');
}

function instanceLabel(instance) {
  const uin = instanceIdentity(instance);
  return uin ? `QQ ${uin}` : `实例 ${instance.id}`;
}

function effectivePhase(instance) {
  return instance.login.online ? 'online' : instance.login.phase;
}

function askConfirmation({ title, message, acceptLabel = '确认' }) {
  if (confirmResolver) confirmResolver(false);
  confirmTitle.textContent = title;
  confirmMessage.textContent = message;
  confirmAccept.textContent = acceptLabel;
  confirmDialog.showModal();
  return new Promise(resolve => { confirmResolver = resolve; });
}

function settleConfirmation(value) {
  const resolve = confirmResolver;
  confirmResolver = null;
  if (confirmDialog.open) confirmDialog.close();
  resolve?.(value);
}

confirmAccept.addEventListener('click', () => settleConfirmation(true));
confirmCancel.addEventListener('click', () => settleConfirmation(false));
confirmDialog.addEventListener('cancel', event => {
  event.preventDefault();
  settleConfirmation(false);
});

function createInstanceCard(id) {
  const card = document.createElement('article');
  card.className = 'panel instance-card';
  card.dataset.instanceId = id;
  card.innerHTML = `
    <div class="instance-head">
      <div class="account-identity">
        <span class="account-avatar">QQ</span>
        <div class="account-heading"><p class="instance-id"></p><h3 class="instance-name"></h3></div>
      </div>
      <span class="phase-badge"></span>
    </div>
    <div class="instance-body">
      <div class="qr-frame">
        <img class="qr-image" alt="QQ 登录二维码（由 QQ 内核直接返回）" hidden />
        <div class="qr-placeholder"><span class="placeholder-icon" aria-hidden="true">⌁</span><strong class="placeholder-title">等待实例启动</strong><small class="placeholder-detail">启动后将直接显示 QQ 内核二维码</small></div>
      </div>
      <div class="instance-info">
        <dl class="meta-list">
          <div><dt>进程</dt><dd class="process-status">检查中</dd></div>
          <div><dt>账号</dt><dd class="account-status">尚未登录</dd></div>
          <div><dt>登录内核</dt><dd class="kernel-status">检查中</dd></div>
        </dl>
        <p class="instance-error" role="alert"></p>
        <p class="capability-note" hidden></p>
        <div class="quick-login" hidden><p>历史账号快速登录</p><div class="quick-login-list"></div></div>
        <div class="instance-actions">
          <button class="button primary start-button" type="button">启动</button>
          <button class="button ghost stop-button" type="button">停止</button>
          <button class="button secondary refresh-button" type="button">刷新二维码</button>
          <button class="button ghost qq-logout-button" type="button">退出 QQ</button>
        </div>
      </div>
    </div>
    <div class="instance-footer">
      <label class="switch-label"><input class="autostart-toggle" type="checkbox" /><span class="switch-track"></span><span>面板重启时自动启动</span></label>
      <button class="text-button remove-button" type="button">移除实例</button>
    </div>`;
  instancesGrid.append(card);
  const refs = {
    card,
    avatar: card.querySelector('.account-avatar'),
    name: card.querySelector('.instance-name'),
    id: card.querySelector('.instance-id'),
    phase: card.querySelector('.phase-badge'),
    image: card.querySelector('.qr-image'),
    placeholder: card.querySelector('.qr-placeholder'),
    placeholderTitle: card.querySelector('.placeholder-title'),
    placeholderDetail: card.querySelector('.placeholder-detail'),
    process: card.querySelector('.process-status'),
    account: card.querySelector('.account-status'),
    kernel: card.querySelector('.kernel-status'),
    error: card.querySelector('.instance-error'),
    capability: card.querySelector('.capability-note'),
    quick: card.querySelector('.quick-login'),
    quickList: card.querySelector('.quick-login-list'),
    start: card.querySelector('.start-button'),
    stop: card.querySelector('.stop-button'),
    refresh: card.querySelector('.refresh-button'),
    logout: card.querySelector('.qq-logout-button'),
    autostart: card.querySelector('.autostart-toggle'),
    remove: card.querySelector('.remove-button'),
    revision: null,
    busy: false,
  };

  refs.start.addEventListener('click', () => runInstanceAction(refs, 'start'));
  refs.stop.addEventListener('click', async () => {
    const instance = currentStatus?.instances.find(item => item.id === refs.card.dataset.instanceId);
    if (!instance) return;
    const approved = await askConfirmation({
      title: `停止 ${instanceLabel(instance)}？`,
      message: '这只会结束该实例的 QQ 进程，不会退出账号，也不会清除登录资料。其他 QQ 实例不受影响。',
      acceptLabel: '停止实例',
    });
    if (approved) await runInstanceAction(refs, 'stop');
  });
  refs.refresh.addEventListener('click', () => runInstanceAction(refs, 'refresh'));
  refs.logout.addEventListener('click', async () => {
    const instance = currentStatus?.instances.find(item => item.id === refs.card.dataset.instanceId);
    if (!instance) return;
    const approved = await askConfirmation({
      title: `退出 ${instanceLabel(instance)}？`,
      message: '该 QQ 会真正下线并回到登录状态；实例配置和账号数据仍会保留。其他账号不受影响。',
      acceptLabel: '确认退出 QQ',
    });
    if (approved) await runInstanceAction(refs, 'logout');
  });
  refs.autostart.addEventListener('change', async () => {
    const wanted = refs.autostart.checked;
    refs.autostart.disabled = true;
    try {
      await api(`/api/instances/${encodeURIComponent(refs.card.dataset.instanceId)}`, {
        method: 'PATCH', body: JSON.stringify({ autostart: wanted }),
      });
      showToast(wanted ? '已开启自动启动' : '已关闭自动启动');
      await refreshStatus();
    } catch (error) {
      refs.autostart.checked = !wanted;
      if (error.status === 401) return showLogin();
      showToast(error.message, 'error');
    } finally {
      refs.autostart.disabled = false;
    }
  });
  refs.remove.addEventListener('click', async () => {
    const instance = currentStatus?.instances.find(item => item.id === refs.card.dataset.instanceId);
    if (!instance) return;
    const approved = await askConfirmation({
      title: `移除 ${instanceLabel(instance)}？`,
      message: '只会从管理页面和 config.json 移除该实例，不会删除磁盘上的 QQ 数据。运行中的实例必须先停止。',
      acceptLabel: '移除实例',
    });
    if (!approved) return;
    setBusy(refs, true);
    try {
      await api(`/api/instances/${encodeURIComponent(instance.id)}`, { method: 'DELETE', body: '{}' });
      showToast(`${instanceLabel(instance)} 已从面板移除，账号数据仍保留`);
      await refreshStatus();
    } catch (error) {
      if (error.status === 401) return showLogin();
      refs.error.textContent = error.message;
    } finally {
      setBusy(refs, false);
    }
  });
  refs.image.addEventListener('error', () => {
    refs.image.hidden = true;
    refs.placeholder.hidden = false;
    refs.placeholderTitle.textContent = '二维码读取失败';
    refs.placeholderDetail.textContent = '请刷新二维码或检查登录桥';
  });
  cards.set(id, refs);
  return refs;
}

function setBusy(refs, busy) {
  refs.busy = busy;
  for (const control of [refs.start, refs.stop, refs.refresh, refs.logout, refs.autostart, refs.remove]) {
    control.disabled = busy || control.dataset.disabled === 'true';
  }
}

async function runInstanceAction(refs, action, body = {}) {
  refs.error.textContent = '';
  setBusy(refs, true);
  try {
    await api(`/api/instances/${encodeURIComponent(refs.card.dataset.instanceId)}/${action}`, {
      method: 'POST', body: JSON.stringify(body),
    });
    const messages = { start: '实例已启动', stop: '实例已停止', refresh: '二维码刷新请求已发送', logout: 'QQ 退出请求已发送' };
    showToast(messages[action] || '操作成功');
    await refreshStatus();
  } catch (error) {
    if (error.status === 401) return showLogin();
    refs.error.textContent = error.message;
  } finally {
    setBusy(refs, false);
  }
}

function renderQuickLogin(refs, instance) {
  const accounts = instance.login.quickLoginAccounts || [];
  refs.quick.hidden = accounts.length === 0 || instance.login.online;
  refs.quickList.replaceChildren();
  for (const account of accounts) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'account-chip';
    button.textContent = account.nickname ? `${account.nickname} · ${account.uin}` : account.uin;
    button.addEventListener('click', () => runInstanceAction(refs, 'quick-login', { uin: account.uin }));
    refs.quickList.append(button);
  }
}

function renderQr(refs, instance) {
  const login = instance.login;
  if (login.qrcodeAvailable && !login.online) {
    if (refs.revision !== login.qrcodeRevision) {
      refs.revision = login.qrcodeRevision;
      refs.image.src = `/api/instances/${encodeURIComponent(instance.id)}/qrcode?v=${login.qrcodeRevision}`;
    }
    refs.image.hidden = false;
    refs.placeholder.hidden = true;
    return;
  }
  refs.image.hidden = true;
  refs.image.removeAttribute('src');
  refs.revision = null;
  refs.placeholder.hidden = false;
  const phase = effectivePhase(instance);
  const placeholders = {
    stopped: instance.enabled ? ['实例尚未启动', '点击“启动”后获取登录二维码'] : ['实例已停用', '请在服务器配置中重新启用'],
    agent_unavailable: ['QQ 已运行，登录桥未连接', '检查加载器，或停止并重新启动该实例'],
    online: ['QQ 已在线', instanceIdentity(instance) ? `QQ ${instanceIdentity(instance)}` : 'QQ 内核已确认在线'],
    connected: ['已退出登录', '点击“刷新二维码”登录账号'],
    expired: ['二维码已过期', '点击“刷新二维码”重新生成'],
    scanned: ['已经扫码', '请在手机 QQ 中确认登录'],
    logging_out: ['正在退出 QQ', '等待 QQ 内核确认退出结果'],
    account_mismatch: ['账号不匹配', '错误账号已自动退出，请使用此卡片对应的 QQ 扫码'],
    failed: ['暂时无法完成操作', '查看右侧错误后重试'],
  };
  const [title, detail] = placeholders[phase] || ['正在准备二维码', phaseLabels[phase] || '等待 QQ 登录内核'];
  refs.placeholderTitle.textContent = title;
  refs.placeholderDetail.textContent = detail;
}

function renderInstance(instance) {
  const refs = cards.get(instance.id) || createInstanceCard(instance.id);
  const uin = instanceIdentity(instance);
  const phase = effectivePhase(instance);
  refs.avatar.textContent = uin ? uin.slice(-2) : 'QQ';
  refs.name.textContent = uin || `实例 ${instance.id}`;
  refs.id.textContent = uin ? 'QQ ACCOUNT' : `MIGRATED INSTANCE / ${instance.id}`;
  refs.phase.textContent = phaseLabels[phase] || phase;
  refs.phase.dataset.phase = phase;
  refs.process.textContent = instance.process.running
    ? `PID ${instance.process.pid}${instance.process.duplicatePids.length ? ` · ${instance.process.duplicatePids.length} 个重复进程` : ''}`
    : '未运行';
  refs.account.textContent = uin ? `QQ ${uin}` : (instance.login.online ? '已在线，QQ 号待内核回报' : '尚未登录');
  refs.kernel.textContent = instance.login.connected ? '已连接' : (instance.process.running ? '等待连接' : '未启动');
  refs.error.textContent = instance.startError || instance.login.error || '';

  const needsReload = instance.process.running && instance.login.online && !instance.login.capabilities?.logout;
  refs.capability.hidden = !needsReload;
  refs.capability.textContent = needsReload ? '此实例仍在使用旧版登录桥；按你的时间停止并重新启动一次后，即可从网页真正退出 QQ。' : '';

  const canStart = instance.enabled && !instance.process.running;
  const canStop = instance.process.running;
  const canRefresh = instance.process.running && instance.login.connected && !instance.login.online;
  const canLogout = instance.process.running && instance.login.online && instance.login.capabilities?.logout;
  refs.start.dataset.disabled = String(!canStart);
  refs.stop.dataset.disabled = String(!canStop);
  refs.refresh.dataset.disabled = String(!canRefresh);
  refs.logout.dataset.disabled = String(!canLogout);
  refs.remove.dataset.disabled = String(instance.process.running);
  refs.start.disabled = refs.busy || !canStart;
  refs.stop.disabled = refs.busy || !canStop;
  refs.refresh.disabled = refs.busy || !canRefresh;
  refs.logout.disabled = refs.busy || !canLogout;
  refs.remove.disabled = refs.busy || instance.process.running;
  refs.autostart.checked = instance.autostart;
  refs.autostart.disabled = refs.busy;
  refs.remove.title = instance.process.running ? '请先停止实例' : '移除配置并保留账号数据';
  refs.logout.title = needsReload ? '停止并重新启动此实例后可用' : '';
  renderQr(refs, instance);
  renderQuickLogin(refs, instance);
}

function renderStatus(data) {
  currentStatus = data;
  const { runtime, instances } = data;
  setGlobalStatus('loader', runtime.loader.installed, runtime.loader.message, runtime.loader.state === 'conflicting_loader');
  setGlobalStatus('display', runtime.xvfb.ready, runtime.xvfb.ready ? `${runtime.xvfb.display} 已就绪` : `${runtime.xvfb.display} 未就绪`);
  setGlobalStatus('qq', runtime.qq.available, runtime.qq.available ? runtime.qq.command : `${runtime.qq.command} 不可用`);
  const running = instances.filter(instance => instance.process.running).length;
  const online = instances.filter(instance => instance.login.online).length;
  setGlobalStatus('instances', running > 0, `${running}/${instances.length} 运行 · ${online} 已在线`);
  document.querySelector('#summary-online').textContent = String(online);
  document.querySelector('#summary-running').textContent = String(running);
  document.querySelector('#summary-total').textContent = String(instances.length);
  runtimeError.hidden = !data.bootstrapError;
  runtimeError.textContent = data.bootstrapError ? `自动启动未完全成功：${data.bootstrapError}` : '';
  emptyState.hidden = instances.length > 0;

  const currentIds = new Set(instances.map(instance => instance.id));
  for (const [id, refs] of cards) {
    if (!currentIds.has(id)) {
      refs.card.remove();
      cards.delete(id);
    }
  }
  for (const instance of instances) renderInstance(instance);
}

async function refreshStatus() {
  if (refreshRunning || portalPanel.hidden) return;
  refreshRunning = true;
  clearTimeout(refreshTimer);
  try {
    renderStatus(await api('/api/status'));
  } catch (error) {
    if (error.status === 401) return showLogin();
    runtimeError.hidden = false;
    runtimeError.textContent = error.message;
  } finally {
    refreshRunning = false;
    if (!portalPanel.hidden) refreshTimer = setTimeout(refreshStatus, 2_000);
  }
}

async function openSettings() {
  settingsError.textContent = '';
  settingsForm.reset();
  try {
    const settings = await api('/api/settings');
    settingsForm.elements.sessionTtlMinutes.value = settings.auth.sessionTtlMinutes;
    settingsForm.elements.maxInstances.value = settings.management.maxInstances;
    document.querySelector('#setting-listen').textContent = `${settings.listen.host}:${settings.listen.port}`;
    document.querySelector('#setting-root').textContent = settings.management.instanceRoot;
    document.querySelector('#setting-cookie').textContent = settings.auth.secureCookie ? 'Secure 已开启' : '当前为普通 HTTP Cookie';
    settingsDialog.showModal();
    settingsForm.elements.currentPassword.focus();
  } catch (error) {
    if (error.status === 401) return showLogin();
    showToast(error.message, 'error');
  }
}

loginForm.addEventListener('submit', async event => {
  event.preventDefault();
  loginError.textContent = '';
  const button = loginForm.querySelector('button');
  button.disabled = true;
  try {
    await api('/api/session', { method: 'POST', body: JSON.stringify({ password: new FormData(loginForm).get('password') }) });
    loginForm.reset();
    showPortal();
  } catch (error) {
    loginError.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

addButton.addEventListener('click', () => {
  addForm.reset();
  addForm.elements.startNow.checked = true;
  addForm.elements.autostart.checked = false;
  addError.textContent = '';
  addDialog.showModal();
  addForm.elements.uin.focus();
});

addForm.addEventListener('submit', async event => {
  event.preventDefault();
  addError.textContent = '';
  const button = addForm.querySelector('[type="submit"]');
  const fields = new FormData(addForm);
  button.disabled = true;
  try {
    const result = await api('/api/instances', {
      method: 'POST',
      body: JSON.stringify({
        uin: fields.get('uin'),
        startNow: fields.get('startNow') === 'on',
        autostart: fields.get('autostart') === 'on',
      }),
    });
    addDialog.close();
    await refreshStatus();
    if (result.start?.error) showToast(`QQ ${result.instance.uin} 已新增，但启动失败：${result.start.error}`, 'error');
    else showToast(`QQ ${result.instance.uin} 已新增${result.start ? '并启动' : ''}`);
  } catch (error) {
    if (error.status === 401) return showLogin();
    addError.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

settingsButton.addEventListener('click', () => { void openSettings(); });

settingsForm.addEventListener('submit', async event => {
  event.preventDefault();
  settingsError.textContent = '';
  const fields = new FormData(settingsForm);
  const newPassword = String(fields.get('newPassword') || '');
  const confirmation = String(fields.get('confirmPassword') || '');
  if (newPassword !== confirmation) {
    settingsError.textContent = '两次输入的新密码不一致';
    return;
  }
  const button = settingsForm.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        currentPassword: fields.get('currentPassword'),
        newPassword,
        sessionTtlMinutes: Number(fields.get('sessionTtlMinutes')),
        maxInstances: Number(fields.get('maxInstances')),
      }),
    });
    settingsDialog.close();
    settingsForm.reset();
    showToast(newPassword ? '设置与访问密码已保存' : '管理设置已保存');
  } catch (error) {
    if (error.status === 401) return showLogin();
    settingsError.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

for (const button of document.querySelectorAll('[data-close]')) {
  button.addEventListener('click', () => document.querySelector(`#${button.dataset.close}`).close());
}

for (const dialog of [addDialog, settingsDialog]) {
  dialog.addEventListener('click', event => {
    if (event.target === dialog) dialog.close();
  });
}

logoutButton.addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST', body: '{}' }).catch(() => {});
  showLogin();
});

api('/api/session').then(result => result.authenticated ? showPortal() : showLogin()).catch(showLogin);
