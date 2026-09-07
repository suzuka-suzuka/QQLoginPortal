/* global document */

const PHASE_LABELS = {
  stopped: '未启动', agent_unavailable: '登录桥未连接', initializing: '正在准备',
  connecting: '正在连接', connected: '待登录', refreshing: '正在生成二维码',
  waiting_scan: '等待扫码', scanned: '等待手机确认', quick_login: '正在登录',
  online: '在线', account_mismatch: '账号不匹配', logging_out: '正在退出',
  expired: '二维码已过期', failed: '操作失败', disconnected: '连接已断开',
};

export function instanceIdentity(instance) {
  return String(instance.uin || instance.login?.account?.uin || instance.id);
}

export function effectivePhase(instance) {
  if (!instance.process?.running) return 'stopped';
  return instance.login?.online ? 'online' : instance.login?.phase || 'initializing';
}

export function accountGroup(instance) {
  const phase = effectivePhase(instance);
  return phase === 'stopped' ? 'stopped' : phase === 'online' ? 'online' : 'pending';
}

export function filterInstances(instances, filter = 'all', query = '') {
  const term = query.trim().toLowerCase();
  return instances.filter(instance => (filter === 'all' || accountGroup(instance) === filter)
    && instanceIdentity(instance).toLowerCase().includes(term));
}

export function availableActions(instance) {
  const running = instance.process?.running === true;
  const online = effectivePhase(instance) === 'online';
  return {
    start: instance.enabled !== false && !running,
    stop: running,
    refresh: running && instance.login?.connected === true && !online && !['quick_login', 'logging_out'].includes(effectivePhase(instance)) && instance.login?.recovery?.status !== 'checking',
    logout: running && online && instance.login?.capabilities?.logout === true,
    remove: !running,
  };
}

export function qrPresentation(instance) {
  const phase = effectivePhase(instance);
  const descriptions = {
    stopped: instance.enabled === false ? ['账号已停用', '请在服务器配置中重新启用。'] : ['还没有启动', '点击下方“启动 QQ”获取二维码。'],
    online: ['登录成功', '可以关闭网页，QQ 会继续运行。'],
    scanned: ['扫码成功', '请在手机 QQ 上确认登录。'],
    expired: ['二维码已过期', '点击“刷新二维码”重新获取。'],
    agent_unavailable: ['登录桥未连接', 'QQ 已运行，请检查服务器加载器。'],
    disconnected: ['连接已断开', '等待 QQ 恢复连接后重试。'],
    failed: ['暂时无法登录', '查看下方提示后重试。'],
    account_mismatch: ['账号不匹配', '请使用当前选择的 QQ 号登录。'],
    connected: ['准备扫码登录', '点击“刷新二维码”开始登录。'],
    quick_login: ['正在登录', '等待 QQ 确认登录结果。'],
    logging_out: ['正在退出 QQ', '等待 QQ 确认退出结果。'],
    refreshing: ['正在生成二维码', '二维码准备好后会自动显示。'],
  };
  const [title, detail] = descriptions[phase] || ['正在准备二维码', '稍等一下，正在连接 QQ。'];
  const showImage = instance.process?.running === true && instance.login?.qrcodeAvailable === true
    && !['online', 'scanned', 'expired', 'failed', 'disconnected', 'logging_out', 'account_mismatch', 'quick_login', 'refreshing'].includes(phase);
  return { phase, title, detail, showImage };
}

export function actionFeedback(action, response = {}) {
  if (response.result?.success === false || response.result?.accepted === false || response.accepted === false) {
    return { error: true, message: response.result?.message || response.state?.error || 'QQ 暂未接受操作，请稍后重试。' };
  }
  if (action === 'start' && response.agentReady === false) {
    return { error: true, message: response.message || 'QQ 已启动，但登录桥暂未连接。' };
  }
  const messages = { start: 'QQ 已启动', stop: 'QQ 已停止，账号数据已保留', refresh: '正在刷新二维码', logout: '已发送退出请求', 'quick-login': '正在恢复登录' };
  return { error: false, message: messages[action] || '操作已完成' };
}

function createPortalUI() {
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const icon = name => `<svg class="icon" aria-hidden="true"><use href="#icon-${name}"/></svg>`;
  const loginPanel = $('#login-panel');
  const portalPanel = $('#portal-panel');
  const loginForm = $('#login-form');
  const addDialog = $('#add-dialog');
  const addForm = $('#add-form');
  const settingsForm = $('#settings-form');
  const confirmDialog = $('#confirm-dialog');
  const cardRefs = new Map();
  const scanRefs = new Map();
  const busy = new Set();
  const localErrors = new Map();
  let authenticated = false;
  let epoch = 0;
  let view = 'accounts';
  let filter = 'all';
  let currentStatus = null;
  let selectedId = null;
  let refreshTimer;
  let statusPromise = null;
  let toastTimer;
  let confirmResolver;
  let settingsLoaded = false;
  let settingsPromise = null;
  let imageKey = null;
  let imageFailed = false;
  let quickKey = '';

  const instanceFor = id => currentStatus?.instances.find(instance => instance.id === id);
  const labelFor = instance => `QQ ${instanceIdentity(instance)}`;
  const phaseLabel = instance => PHASE_LABELS[effectivePhase(instance)] || '正在连接';
  const toneFor = instance => ['failed', 'account_mismatch', 'agent_unavailable', 'disconnected'].includes(effectivePhase(instance)) ? 'error' : accountGroup(instance);

  async function api(path, options = {}) {
    const response = await fetch(path, { cache: 'no-store', ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.message || `请求失败（${response.status}）`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function setError(element, message = '') {
    element.textContent = message;
    element.hidden = !message;
  }

  function showToast(message, error = false) {
    clearTimeout(toastTimer);
    const toast = $('#toast');
    toast.textContent = message;
    toast.className = `toast${error ? ' error' : ''}`;
    toast.hidden = false;
    toastTimer = setTimeout(() => { toast.hidden = true; }, 4500);
  }

  function handleError(error) {
    if (error.status === 401) showLogin();
    else showToast(error.message, true);
  }

  function clearQr() {
    $('#qr-image').hidden = true;
    $('#qr-image').removeAttribute('src');
    imageKey = null;
    imageFailed = false;
  }

  function showLogin() {
    epoch++;
    authenticated = false;
    clearTimeout(refreshTimer);
    clearTimeout(toastTimer);
    $('#toast').hidden = true;
    settleConfirmation(false);
    if (addDialog.open) addDialog.close();
    addForm.reset();
    settingsForm.reset();
    settingsLoaded = false;
    settingsPromise = null;
    statusPromise = null;
    currentStatus = null;
    selectedId = null;
    cardRefs.clear();
    scanRefs.clear();
    busy.clear();
    localErrors.clear();
    $('#instances-grid').replaceChildren();
    $('#scan-account-list').replaceChildren();
    $('#quick-login-list').replaceChildren();
    quickKey = '';
    clearQr();
    $('#boot-status').hidden = true;
    portalPanel.hidden = true;
    loginPanel.hidden = false;
    $('#password').type = 'password';
    $('#password-visibility').setAttribute('aria-pressed', 'false');
    $('#password-visibility').setAttribute('aria-label', '显示密码');
    $('#password').focus();
  }

  function showPortal() {
    epoch++;
    authenticated = true;
    $('#boot-status').hidden = true;
    loginPanel.hidden = true;
    portalPanel.hidden = false;
    view = 'accounts';
    filter = 'all';
    $('#account-search').value = '';
    selectView('accounts', false);
    void refreshStatus();
  }

  function selectView(next, moveFocus = true) {
    if (!['accounts', 'scan', 'settings'].includes(next)) return;
    view = next;
    const copy = {
      accounts: ['我的账号', '登录、切换、管理，在这里就好。'],
      scan: ['扫码登录', '选一个账号，拿起手机扫一扫。'],
      settings: ['面板设置', '只保留你真正需要的设置。'],
    }[view];
    $('#page-title').textContent = copy[0];
    $('#page-description').textContent = copy[1];
    document.title = `${copy[0]} · QQ Login Portal`;
    for (const button of $$('[data-view]')) {
      if (button.dataset.view === view) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    for (const name of ['accounts', 'scan', 'settings']) $(`#${name}-view`).hidden = name !== view;
    if (view !== 'scan') clearQr();
    if (view === 'scan') renderScan();
    if (view === 'settings') void loadSettings();
    if (moveFocus) $('#page-title').focus({ preventScroll: true });
  }

  function showScan(id) {
    if (selectedId !== id) clearQr();
    selectedId = id;
    selectView('scan');
  }

  function askConfirmation(title, message, acceptLabel) {
    settleConfirmation(false);
    $('#confirm-title').textContent = title;
    $('#confirm-message').textContent = message;
    $('#confirm-accept').textContent = acceptLabel;
    confirmDialog.showModal();
    $('#confirm-cancel').focus();
    return new Promise(resolve => { confirmResolver = resolve; });
  }

  function settleConfirmation(accepted) {
    const resolve = confirmResolver;
    confirmResolver = null;
    if (confirmDialog.open) confirmDialog.close();
    resolve?.(accepted);
  }

  async function runAction(id, action, body = {}) {
    if (busy.has(id) || !instanceFor(id)) return;
    const actionEpoch = epoch;
    busy.add(id);
    localErrors.delete(id);
    renderStatus(currentStatus);
    try {
      const response = await api(`/api/instances/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: JSON.stringify(body) });
      if (!authenticated || actionEpoch !== epoch) return;
      const feedback = actionFeedback(action, response);
      if (feedback.error) localErrors.set(id, feedback.message);
      showToast(feedback.message, feedback.error);
      if (action === 'refresh') clearQr();
      await refreshAfterAction();
    } catch (error) {
      if (actionEpoch !== epoch) return;
      if (error.status === 401) return showLogin();
      localErrors.set(id, error.message);
      showToast(error.message, true);
    } finally {
      if (actionEpoch === epoch) {
        busy.delete(id);
        if (currentStatus) renderStatus(currentStatus);
      }
    }
  }

  async function confirmAction(id, action) {
    const instance = instanceFor(id);
    if (!instance || busy.has(id)) return;
    const copy = {
      stop: [`停止 ${labelFor(instance)}？`, '只结束这个 QQ 的进程，不清除账号数据。再次启动时可能需要重新扫码，其他账号不受影响。', '停止 QQ'],
      logout: [`退出 ${labelFor(instance)}？`, '该 QQ 会下线并返回登录状态。账号配置和数据仍会保留，其他账号不受影响。', '退出 QQ'],
      remove: [`移除 ${labelFor(instance)}？`, '只从面板移除账号配置，不会删除服务器上的 QQ 数据。', '移除账号'],
    }[action];
    if (!await askConfirmation(...copy) || !authenticated) return;
    if (action !== 'remove') return runAction(id, action);
    const actionEpoch = epoch;
    busy.add(id);
    renderStatus(currentStatus);
    try {
      await api(`/api/instances/${encodeURIComponent(id)}`, { method: 'DELETE', body: '{}' });
      if (actionEpoch !== epoch) return;
      showToast('账号已从面板移除，数据仍保留');
      await refreshAfterAction();
    } catch (error) { if (actionEpoch === epoch) handleError(error); }
    finally {
      if (actionEpoch === epoch) {
        busy.delete(id);
        if (currentStatus) renderStatus(currentStatus);
      }
    }
  }

  function renderAvatar(element, identity) {
    if (element.dataset.uin === identity) return;
    element.dataset.uin = identity;
    element.innerHTML = icon('accounts');
    if (!/^[1-9]\d{4,19}$/.test(identity)) return;
    const image = document.createElement('img');
    image.alt = '';
    image.referrerPolicy = 'no-referrer';
    image.loading = 'lazy';
    image.decoding = 'async';
    image.addEventListener('error', () => image.remove(), { once: true });
    image.src = `https://q1.qlogo.cn/g?b=qq&nk=${identity}&s=100`;
    element.append(image);
  }

  function createCard(id) {
    const card = document.createElement('article');
    card.className = 'account-card';
    card.dataset.instanceId = id;
    card.innerHTML = `<header class="account-head"><span class="account-avatar" aria-hidden="true"></span><div class="account-heading"><span class="account-label">QQ 账号</span><h2 class="account-number"></h2></div><details class="account-menu"><summary class="icon-button">${icon('more')}</summary><div class="menu-content"><button class="stop-button" type="button">${icon('stop')}停止 QQ</button><button class="qq-logout-button" type="button">${icon('logout')}退出 QQ</button><p class="menu-note capability-note" hidden>当前 QQ 内核不支持主动退出，停止进程不等于退出账号。</p><div class="menu-separator"></div><button class="remove-button" type="button">${icon('trash')}移除账号</button><p class="menu-note remove-note">请先停止 QQ，再移除账号。</p></div></details></header><div class="account-state"><span class="status-badge"></span></div><p class="account-description"></p><p class="card-error" role="alert" hidden></p><footer class="account-footer"><label class="switch-label"><input class="autostart-toggle" type="checkbox" role="switch"/><span class="switch-track" aria-hidden="true"></span><span>自动启动</span></label><button class="button soft login-button" type="button">扫码登录</button></footer>`;
    const refs = { card };
    for (const [key, selector] of Object.entries({ avatar: '.account-avatar', number: '.account-number', menu: 'details', summary: 'summary', phase: '.status-badge', description: '.account-description', error: '.card-error', stop: '.stop-button', logout: '.qq-logout-button', capability: '.capability-note', remove: '.remove-button', removeNote: '.remove-note', autostart: '.autostart-toggle', login: '.login-button' })) refs[key] = card.querySelector(selector);
    for (const action of ['stop', 'logout', 'remove']) refs[action].addEventListener('click', () => { refs.menu.open = false; void confirmAction(id, action); });
    refs.menu.addEventListener('toggle', () => {
      if (refs.menu.open) for (const other of cardRefs.values()) if (other !== refs) other.menu.open = false;
    });
    refs.login.addEventListener('click', () => {
      const instance = instanceFor(id);
      if (!instance) return;
      showScan(id);
      if (availableActions(instance).start) void runAction(id, 'start');
    });
    refs.autostart.addEventListener('change', async () => {
      if (busy.has(id)) return;
      const actionEpoch = epoch;
      const autostart = refs.autostart.checked;
      busy.add(id);
      renderStatus(currentStatus);
      try {
        await api(`/api/instances/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ autostart }) });
        if (actionEpoch !== epoch) return;
        showToast(autostart ? '已开启自动启动' : '已关闭自动启动');
        await refreshAfterAction();
      } catch (error) { if (actionEpoch === epoch) handleError(error); }
      finally {
        if (actionEpoch === epoch) {
          busy.delete(id);
          if (currentStatus) renderStatus(currentStatus);
        }
      }
    });
    $('#instances-grid').append(card);
    cardRefs.set(id, refs);
    return refs;
  }

  function renderCard(instance) {
    const refs = cardRefs.get(instance.id) || createCard(instance.id);
    const identity = instanceIdentity(instance);
    const actions = availableActions(instance);
    const phase = effectivePhase(instance);
    refs.number.textContent = identity;
    renderAvatar(refs.avatar, identity);
    refs.summary.setAttribute('aria-label', `管理 QQ ${identity}`);
    refs.phase.textContent = phaseLabel(instance);
    refs.phase.dataset.tone = toneFor(instance);
    refs.description.textContent = phase === 'online' ? '已登录，可以安心关闭网页。'
      : phase === 'quick_login' ? '正在恢复已保存的登录，请稍等。'
      : phase === 'stopped' ? (instance.enabled === false ? '这个账号已在配置中停用。' : '需要时再启动，登录资料会保留。')
        : phase === 'scanned' ? '已收到扫码，请在手机 QQ 确认。'
          : phase === 'agent_unavailable' ? 'QQ 已运行，暂时无法连接登录桥。'
            : phase === 'expired' ? '二维码过期了，前往扫码页刷新即可。'
              : '前往扫码页，完成这个账号的登录。';
    setError(refs.error, localErrors.get(instance.id) || instance.startError || instance.login?.error || '');
    for (const action of ['stop', 'logout', 'remove']) refs[action].disabled = busy.has(instance.id) || !actions[action];
    refs.capability.hidden = !instance.process?.running || instance.login?.capabilities?.logout === true;
    refs.removeNote.hidden = actions.remove;
    refs.logout.title = refs.capability.hidden ? '' : '当前 QQ 内核不支持主动退出';
    refs.remove.title = actions.remove ? '仅移除配置，保留账号数据' : '请先停止 QQ';
    if (!busy.has(instance.id)) refs.autostart.checked = instance.autostart === true;
    refs.autostart.disabled = busy.has(instance.id);
    refs.autostart.setAttribute('aria-label', `QQ ${identity} 自动启动`);
    refs.login.hidden = phase === 'online';
    refs.login.disabled = busy.has(instance.id) || (phase === 'stopped' && !actions.start);
    refs.login.textContent = busy.has(instance.id) ? '处理中…' : phase === 'stopped' ? (actions.start ? '启动并登录' : '已停用') : '扫码登录';
  }

  function renderAccounts() {
    const instances = currentStatus?.instances || [];
    const matches = new Set(filterInstances(instances, filter, $('#account-search').value).map(instance => instance.id));
    for (const [id, refs] of cardRefs) refs.card.hidden = !matches.has(id);
    for (const button of $$('[data-filter]')) button.setAttribute('aria-pressed', String(button.dataset.filter === filter));
    for (const count of $$('[data-count]')) count.textContent = String(count.dataset.count === 'all' ? instances.length : instances.filter(instance => accountGroup(instance) === count.dataset.count).length);
    $('#empty-state').hidden = matches.size > 0;
    const noAccounts = instances.length === 0;
    $('#empty-title').textContent = noAccounts ? '添加你的第一个 QQ' : '这里暂时没有账号';
    $('#empty-message').textContent = noAccounts ? '只需填写 QQ 号，就可以开始扫码登录。' : '试试其他状态，或换一个 QQ 号搜索。';
    $('#empty-add-button').hidden = !noAccounts;
    $('#clear-filter-button').hidden = noAccounts;
    $('#accounts-footnote').hidden = noAccounts || matches.size === 0;
  }

  function renderScanList() {
    const instances = currentStatus?.instances || [];
    const ids = new Set(instances.map(instance => instance.id));
    for (const [id, refs] of scanRefs) if (!ids.has(id)) { refs.button.remove(); scanRefs.delete(id); }
    if (!ids.has(selectedId)) {
      selectedId = instances.find(instance => accountGroup(instance) === 'pending')?.id || instances[0]?.id || null;
      clearQr();
    }
    for (const instance of instances) {
      let refs = scanRefs.get(instance.id);
      if (!refs) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'scan-account-button';
        button.innerHTML = '<span class="account-avatar" aria-hidden="true"></span><span><strong></strong><small></small></span>';
        refs = { button, avatar: button.querySelector('.account-avatar'), number: button.querySelector('strong'), phase: button.querySelector('small') };
        button.addEventListener('click', () => { selectedId = instance.id; clearQr(); renderScan(); });
        $('#scan-account-list').append(button);
        scanRefs.set(instance.id, refs);
      }
      refs.number.textContent = instanceIdentity(instance);
      renderAvatar(refs.avatar, instanceIdentity(instance));
      refs.phase.textContent = phaseLabel(instance);
      refs.button.setAttribute('aria-pressed', String(instance.id === selectedId));
      refs.button.setAttribute('aria-label', `选择 QQ ${instanceIdentity(instance)}`);
    }
    $('#scan-account-count').textContent = `${instances.length} 个账号`;
    $('#scan-list-empty').hidden = instances.length > 0;
  }

  function renderScan() {
    renderScanList();
    const instance = instanceFor(selectedId);
    $('#scan-empty').hidden = Boolean(instance);
    $('#scan-content').hidden = !instance;
    if (!instance) { clearQr(); return; }
    const presentation = qrPresentation(instance);
    const actions = availableActions(instance);
    $('#scan-uin').textContent = instanceIdentity(instance);
    $('#scan-phase').textContent = phaseLabel(instance);
    $('#scan-phase').dataset.tone = toneFor(instance);
    $('#qr-frame').dataset.phase = presentation.phase;
    $('#qr-placeholder-title').textContent = presentation.title;
    $('#qr-placeholder-detail').textContent = presentation.detail;
    $('#qr-placeholder-icon use').setAttribute('href', `#icon-${presentation.phase === 'online' || presentation.phase === 'scanned' ? 'check' : 'qr'}`);
    const image = $('#qr-image');
    if (view === 'scan' && presentation.showImage) {
      const nextKey = `${instance.id}:${instance.process.pid}:${instance.login.qrcodeRevision}`;
      if (nextKey !== imageKey) {
        imageKey = nextKey;
        imageFailed = false;
        image.src = `/api/instances/${encodeURIComponent(instance.id)}/qrcode?v=${encodeURIComponent(nextKey)}`;
      }
      image.hidden = imageFailed;
      $('#qr-placeholder').hidden = !imageFailed;
      if (imageFailed) {
        $('#qr-placeholder-title').textContent = '二维码读取失败';
        $('#qr-placeholder-detail').textContent = '请刷新二维码后重试。';
      }
    } else {
      clearQr();
      $('#qr-placeholder').hidden = false;
    }
    $('#scan-help').textContent = presentation.phase === 'online' ? '这个账号已经登录，不需要再次扫码。' : '使用当前 QQ 号的手机端扫码，并确认登录。';
    setError($('#scan-error'), localErrors.get(instance.id) || instance.startError || instance.login?.error || (instance.login?.recovery?.status === 'qr_required' ? instance.login.recovery.message : '') || '');
    $('#scan-start').hidden = instance.process?.running === true;
    $('#scan-start').disabled = busy.has(instance.id) || !actions.start;
    $('#scan-refresh').hidden = !instance.process?.running || presentation.phase === 'online';
    $('#scan-refresh').disabled = busy.has(instance.id) || !actions.refresh;
    const accounts = (instance.login?.quickLoginAccounts || []).filter(account => !instance.uin || account.uin === instance.uin);
    const quickVisible = actions.refresh && accounts.length > 0;
    $('#quick-login').hidden = !quickVisible;
    const nextQuickKey = JSON.stringify([instance.id, accounts.map(account => [account.uin, account.nickname])]);
    if (nextQuickKey !== quickKey) {
      quickKey = nextQuickKey;
      $('#quick-login-list').replaceChildren();
      for (const account of accounts) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'button secondary';
        button.textContent = `快速登录 ${account.uin}`;
        button.addEventListener('click', () => { void runAction(instance.id, 'quick-login', { uin: account.uin }); });
        $('#quick-login-list').append(button);
      }
    }
    for (const button of $$('#quick-login-list button')) button.disabled = busy.has(instance.id) || !actions.refresh;
  }

  function renderStatus(data) {
    if (!data || !authenticated) return;
    currentStatus = data;
    const ids = new Set(data.instances.map(instance => instance.id));
    for (const [id, refs] of cardRefs) if (!ids.has(id)) { refs.card.remove(); cardRefs.delete(id); localErrors.delete(id); }
    for (const instance of data.instances) renderCard(instance);
    renderAccounts();
    if (view === 'scan') renderScan();
    setError($('#service-error'), data.bootstrapError ? `部分账号未能自动启动：${data.bootstrapError}` : '');
  }

  function refreshStatus() {
    if (!authenticated) return Promise.resolve();
    if (statusPromise) return statusPromise;
    clearTimeout(refreshTimer);
    const refreshEpoch = epoch;
    const pending = api('/api/status').then(data => {
      if (authenticated && refreshEpoch === epoch) renderStatus(data);
    }).catch(error => {
      if (refreshEpoch !== epoch) return;
      if (error.status === 401) showLogin();
      else setError($('#service-error'), `暂时无法读取账号状态：${error.message}`);
    }).finally(() => {
      if (statusPromise === pending) statusPromise = null;
      if (authenticated && refreshEpoch === epoch) refreshTimer = setTimeout(refreshStatus, 2000);
    });
    statusPromise = pending;
    return pending;
  }

  async function refreshAfterAction() {
    if (statusPromise) await statusPromise;
    return refreshStatus();
  }

  async function loadSettings() {
    if (settingsLoaded || settingsPromise) return settingsPromise;
    const settingsEpoch = epoch;
    $('#settings-loading').hidden = false;
    $('#settings-save').disabled = true;
    setError($('#settings-error'));
    const pending = api('/api/settings').then(settings => {
      if (!authenticated || settingsEpoch !== epoch) return;
      settingsForm.elements.sessionTtlMinutes.value = settings.auth.sessionTtlMinutes;
      settingsForm.elements.maxInstances.value = settings.management.maxInstances;
      $('#settings-transport').textContent = settings.auth.secureCookie ? '已启用 Secure Cookie，请通过 HTTPS 访问面板。' : '当前未启用 Secure Cookie，建议通过 HTTPS 或 SSH 隧道访问。';
      settingsLoaded = true;
    }).catch(error => {
      if (settingsEpoch !== epoch) return;
      if (error.status === 401) showLogin();
      else setError($('#settings-error'), `读取设置失败：${error.message}。重新点击“设置”可重试。`);
    }).finally(() => {
      if (settingsEpoch === epoch) {
        $('#settings-loading').hidden = true;
        $('#settings-save').disabled = !settingsLoaded;
      }
      if (settingsPromise === pending) settingsPromise = null;
    });
    settingsPromise = pending;
    return pending;
  }

  function openAdd() {
    addForm.reset();
    setError($('#add-error'));
    addDialog.showModal();
    $('#new-uin').focus();
  }

  for (const button of $$('[data-view]')) button.addEventListener('click', () => selectView(button.dataset.view));
  for (const button of $$('[data-filter]')) button.addEventListener('click', () => { filter = button.dataset.filter; renderAccounts(); });
  $('#account-search').addEventListener('input', renderAccounts);
  $('#clear-filter-button').addEventListener('click', () => { filter = 'all'; $('#account-search').value = ''; renderAccounts(); });
  $('#add-instance-button').addEventListener('click', openAdd);
  $('#empty-add-button').addEventListener('click', openAdd);
  $('#scan-start').addEventListener('click', () => { void runAction(selectedId, 'start'); });
  $('#scan-refresh').addEventListener('click', () => { void runAction(selectedId, 'refresh'); });
  $('#scan-back').addEventListener('click', () => selectView('accounts'));
  $('#confirm-accept').addEventListener('click', () => settleConfirmation(true));
  $('#confirm-cancel').addEventListener('click', () => settleConfirmation(false));
  confirmDialog.addEventListener('cancel', event => { event.preventDefault(); settleConfirmation(false); });
  $('#qr-image').addEventListener('error', () => {
    if (!$('#qr-image').getAttribute('src')) return;
    imageFailed = true;
    if (authenticated && view === 'scan') renderScan();
  });
  $('#password-visibility').addEventListener('click', () => {
    const visible = $('#password').type === 'password';
    $('#password').type = visible ? 'text' : 'password';
    $('#password-visibility').setAttribute('aria-pressed', String(visible));
    $('#password-visibility').setAttribute('aria-label', visible ? '隐藏密码' : '显示密码');
  });
  for (const button of $$('[data-close]')) button.addEventListener('click', () => $(`#${button.dataset.close}`).close());
  addDialog.addEventListener('click', event => {
    if (event.target !== addDialog) return;
    const box = addDialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) addDialog.close();
  });
  document.addEventListener('click', event => { if (!event.target.closest('.account-menu')) for (const refs of cardRefs.values()) refs.menu.open = false; });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') for (const refs of cardRefs.values()) refs.menu.open = false; });

  loginForm.addEventListener('submit', async event => {
    event.preventDefault();
    setError($('#login-error'));
    const button = loginForm.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      await api('/api/session', { method: 'POST', body: JSON.stringify({ password: new FormData(loginForm).get('password') }) });
      loginForm.reset();
      showPortal();
    } catch (error) { setError($('#login-error'), error.message); }
    finally { button.disabled = false; }
  });

  addForm.addEventListener('submit', async event => {
    event.preventDefault();
    setError($('#add-error'));
    const button = addForm.querySelector('[type="submit"]');
    const fields = new FormData(addForm);
    const actionEpoch = epoch;
    const startNow = fields.get('startNow') === 'on';
    button.disabled = true;
    try {
      const result = await api('/api/instances', { method: 'POST', body: JSON.stringify({ uin: String(fields.get('uin')).trim(), startNow, autostart: fields.get('autostart') === 'on' }) });
      if (!authenticated || actionEpoch !== epoch) return;
      addDialog.close();
      filter = 'all';
      $('#account-search').value = '';
      await refreshAfterAction();
      if (!authenticated || actionEpoch !== epoch) return;
      const error = result.start?.error || (result.start?.agentReady === false ? result.start.message || '登录桥暂未连接' : '');
      showToast(error ? `账号已添加，但启动未完成：${error}` : 'QQ 账号已添加', Boolean(error));
      if (startNow) showScan(result.instance.id);
      else selectView('accounts');
    } catch (error) {
      if (actionEpoch !== epoch) return;
      if (error.status === 401) showLogin();
      else setError($('#add-error'), error.message);
    } finally { button.disabled = false; }
  });

  settingsForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (!settingsLoaded) return;
    setError($('#settings-error'));
    const fields = new FormData(settingsForm);
    const newPassword = String(fields.get('newPassword') || '');
    if (newPassword !== String(fields.get('confirmPassword') || '')) {
      setError($('#settings-error'), '两次输入的新密码不一致。');
      settingsForm.elements.confirmPassword.focus();
      return;
    }
    const actionEpoch = epoch;
    $('#settings-save').disabled = true;
    try {
      const result = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ currentPassword: fields.get('currentPassword'), newPassword, sessionTtlMinutes: Number(fields.get('sessionTtlMinutes')), maxInstances: Number(fields.get('maxInstances')) }) });
      if (!authenticated || actionEpoch !== epoch) return;
      for (const name of ['currentPassword', 'newPassword', 'confirmPassword']) settingsForm.elements[name].value = '';
      settingsForm.elements.sessionTtlMinutes.value = result.auth.sessionTtlMinutes;
      settingsForm.elements.maxInstances.value = result.management.maxInstances;
      showToast(newPassword ? '访问密码与设置已保存' : '设置已保存');
    } catch (error) {
      if (actionEpoch !== epoch) return;
      if (error.status === 401) showLogin();
      else setError($('#settings-error'), error.message);
    } finally { $('#settings-save').disabled = !settingsLoaded; }
  });

  $('#logout-button').addEventListener('click', async () => {
    const button = $('#logout-button');
    button.disabled = true;
    try {
      await api('/api/logout', { method: 'POST', body: '{}' });
      showLogin();
    } catch (error) { handleError(error); }
    finally { button.disabled = false; }
  });

  api('/api/session').then(result => result.authenticated ? showPortal() : showLogin()).catch(() => { showLogin(); setError($('#login-error'), '暂时无法连接服务器，请稍后重试。'); });
}

if (typeof document !== 'undefined') createPortalUI();
