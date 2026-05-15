// Popup script

const $ = id => document.getElementById(id);

let state = {
  connected: false,
  user: null,
  settings: {},
  stats: {},
  history: [],
  queueSize: 0,
  queuePreview: [],
  currentProblem: null,
  backupProgress: { running: false, current: 0, total: 0 },
  syncing: false
};

async function init() {
  const storage = await getStorageLocal(['stats', 'syncHistory', 'settings', 'githubUser']);

  state.connected = !!storage.githubUser;
  state.user = storage.githubUser || null;
  state.settings = storage.settings || {};
  state.stats = storage.stats || {};
  state.history = storage.syncHistory || [];

  $('loading').style.display = 'none';

  if (state.connected && state.user) {
    showDashboard();
  } else {
    $('auth-section').style.display = 'block';
  }

  await refreshAuthStatus();
}

async function refreshAuthStatus() {
  const status = await sendMessage({ type: 'GET_STATUS' });
  state.connected = !!status.connected;
  state.user = status.user || null;
  state.settings = status.settings || state.settings || {};
  state.queueSize = safeNumber(status.queueSize);
  state.syncing = !!status.syncing;
  state.queuePreview = Array.isArray(status.queuePreview) ? status.queuePreview : [];
  state.currentProblem = status.currentProblem || null;
  state.backupProgress = status.backupProgress || state.backupProgress;

  if (state.connected && state.user) {
    showDashboard();
  } else {
    $('main-section').style.display = 'none';
    $('auth-section').style.display = 'block';
  }
}

function showDashboard() {
  $('auth-section').style.display = 'none';
  $('main-section').style.display = 'block';

  if (state.user) {
    $('user-avatar').src = safeImageUrl(state.user.avatar_url);
    $('user-name').textContent = state.user.login;
  }

  $('repo-name').textContent = state.settings.repoName || 'LeetCode-Solutions';
  $('auto-sync-toggle').checked = state.settings.autoSync !== false;

  renderStats();
  renderHistory();
  renderQueue();
}

function renderStats() {
  const s = state.stats;
  const total = safeNumber(s.totalSynced);
  const easy = safeNumber(s.easy);
  const medium = safeNumber(s.medium);
  const hard = safeNumber(s.hard);

  $('stat-total').textContent = total;
  $('stat-streak').textContent = safeNumber(s.streak);

  const today = new Date().toDateString();
  const todayCount = (state.history || []).filter(h => h.status === 'success' && new Date(h.timestamp).toDateString() === today).length;
  $('stat-today').textContent = todayCount;

  $('cnt-easy').textContent = easy;
  $('cnt-medium').textContent = medium;
  $('cnt-hard').textContent = hard;

  const pct = n => total > 0 ? Math.round((n / total) * 100) : 0;
  $('bar-easy').style.width = pct(easy) + '%';
  $('bar-medium').style.width = pct(medium) + '%';
  $('bar-hard').style.width = pct(hard) + '%';
}

function renderHistory() {
  const list = $('sync-list');
  const history = (state.history || []).slice(0, 8);

  if (!history.length) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="icon">&#128172;</div>
        <p>No syncs yet.<br>Solve a LeetCode problem to get started!</p>
      </div>`;
    return;
  }

  list.innerHTML = history.map(item => {
    const icon = item.status === 'success' ? '&#9989;' : item.status === 'skipped' ? '&#8635;' : '&#10060;';
    const diff = safeClassName(item.difficulty || '');
    const time = formatTime(item.timestamp);
    return `
      <div class="sync-item">
        <div class="sync-status">${icon}</div>
        <div class="sync-info">
          <div class="sync-title">${escHtml(item.id + '. ' + (item.title || 'Unknown'))}</div>
          <div class="sync-meta">
            <span class="lang-badge">${escHtml(item.language || '')}</span>
            ${item.difficulty ? `<span class="diff-badge diff-${diff}">${escHtml(item.difficulty)}</span>` : ''}
            <span class="sync-time">${time}</span>
          </div>
        </div>
      </div>`;
  }).join('');
}

function renderQueue() {
  const queueCount = $('queue-count');
  const queueCurrent = $('queue-current');
  const queueList = $('queue-list');
  if (!queueCount || !queueCurrent || !queueList) return;

  const pending = safeNumber(state.queueSize);
  const progress = state.backupProgress || {};
  queueCount.textContent = `${pending} pending`;
  if (safeNumber(progress.total) > 0) {
    queueCount.textContent += ` | backup ${safeNumber(progress.current)}/${safeNumber(progress.total)}`;
  }

  if (state.currentProblem) {
    queueCurrent.style.display = 'block';
    queueCurrent.textContent = `Now syncing: ${state.currentProblem.id || ''}. ${state.currentProblem.title || 'Unknown'}`;
  } else {
    queueCurrent.style.display = 'none';
    queueCurrent.textContent = '';
  }

  if (!state.queuePreview.length) {
    queueList.innerHTML = '<div style="font-size:11px;color:var(--muted)">Queue is idle.</div>';
    return;
  }

  queueList.innerHTML = state.queuePreview.map(item => {
    const id = escHtml(item?.id || '');
    const title = escHtml(item?.title || 'Unknown');
    const language = escHtml(item?.language || '');
    return `<div class="queue-item">${id}. ${title}${language ? ` <span style="color:var(--muted)">(${language})</span>` : ''}</div>`;
  }).join('');
}

$('connect-btn').addEventListener('click', async () => {
  $('connect-btn').disabled = true;
  $('connect-btn').textContent = 'Opening GitHub...';

  const res = await sendMessage({ type: 'INITIATE_LOGIN' });
  if (res.valid) {
    state.user = res.user;
    state.connected = true;
    showDashboard();
    showToast('Connected to GitHub!', 'success');
  } else {
    showToast('GitHub login failed: ' + (res.error || 'Authorization was cancelled'), 'error');
  }

  $('connect-btn').disabled = false;
  $('connect-btn').textContent = 'Continue with GitHub';
});

$('connect-pat-btn').addEventListener('click', async () => {
  const tokenInput = $('github-pat');
  const token = tokenInput.value.trim();
  if (!token) {
    showToast('Enter a GitHub personal access token', 'error');
    return;
  }

  $('connect-pat-btn').disabled = true;
  $('connect-pat-btn').textContent = 'Validating...';

  const res = await sendMessage({ type: 'CONNECT_WITH_PAT', token });
  tokenInput.value = '';
  if (res.valid) {
    state.user = res.user;
    state.connected = true;
    showDashboard();
    showToast('Connected to GitHub!', 'success');
  } else {
    showToast('PAT login failed: ' + (res.error || 'Token could not be validated'), 'error');
  }

  $('connect-pat-btn').disabled = false;
  $('connect-pat-btn').textContent = 'Connect with PAT';
});

$('disconnect-btn').addEventListener('click', async () => {
  if (!confirm('Disconnect from GitHub?')) return;
  await sendMessage({ type: 'DISCONNECT' });
  state.connected = false;
  state.user = null;
  $('main-section').style.display = 'none';
  $('auth-section').style.display = 'block';
  showToast('Disconnected', '');
});

$('auto-sync-toggle').addEventListener('change', async (e) => {
  state.settings.autoSync = e.target.checked;
  await sendMessage({ type: 'SAVE_SETTINGS', settings: { autoSync: e.target.checked } });
  showToast(e.target.checked ? 'Auto-sync enabled' : 'Auto-sync disabled', '');
});

$('open-settings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

$('open-index').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });
});

$('view-all-btn').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

let isManualBackupRunning = false;

$('backup-btn').addEventListener('click', async () => {
  if (isManualBackupRunning) {
    await sendMessage({ type: 'STOP_BACKUP' });
    isManualBackupRunning = false;
    $('backup-btn').textContent = 'Backup';
    $('backup-btn').classList.replace('btn-danger', 'btn-secondary');
    $('sync-indicator').style.display = 'none';
    showToast('Backup stopped.', 'info');
    return;
  }

  if (!confirm('Start a full backup?')) return;

  isManualBackupRunning = true;
  $('backup-btn').textContent = 'Stop';
  $('backup-btn').classList.replace('btn-secondary', 'btn-danger');
  $('sync-indicator').style.display = 'flex';

  const res = await sendMessage({ type: 'START_BACKUP' });
  if (!res.ok) {
    showToast('Failed: ' + res.error, 'error');
    isManualBackupRunning = false;
    $('backup-btn').textContent = 'Backup';
    $('backup-btn').classList.replace('btn-danger', 'btn-secondary');
    $('sync-indicator').style.display = 'none';
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'QUEUE_UPDATE') {
    state.queueSize = safeNumber(msg.queueSize);
    state.syncing = !!msg.syncing;
    state.queuePreview = Array.isArray(msg.queuePreview) ? msg.queuePreview : [];
    state.currentProblem = msg.currentProblem || null;
    state.backupProgress = msg.backupProgress || state.backupProgress;
    renderQueue();
  }

  if (msg.type === 'BACKUP_STARTED') {
    showToast(`Backup started: ${safeNumber(msg.total)} solution(s) queued.`, '');
  }

  if (msg.type === 'BACKUP_PROGRESS') {
    $('backup-btn').textContent = `${safeNumber(msg.current)}/${safeNumber(msg.total)}`;
    state.backupProgress = { running: true, current: safeNumber(msg.current), total: safeNumber(msg.total) };
    renderQueue();
  }

  if (msg.type === 'BACKUP_COMPLETE') {
    isManualBackupRunning = false;
    $('backup-btn').textContent = 'Backup';
    $('backup-btn').classList.replace('btn-danger', 'btn-secondary');
    $('sync-indicator').style.display = 'none';
    state.backupProgress = { running: false, current: safeNumber(msg.total), total: safeNumber(msg.total) };
    renderQueue();
    getStorageLocal(['stats', 'syncHistory']).then(data => {
      state.stats = data.stats || {};
      state.history = data.syncHistory || [];
      renderStats();
      renderHistory();
    });
    showToast(safeNumber(msg.total) ? `Backup complete: ${safeNumber(msg.total)} synced.` : 'Backup complete: nothing new to sync.', 'success');
  }

  if (msg.type === 'BACKUP_STOPPED') {
    isManualBackupRunning = false;
    $('backup-btn').textContent = 'Backup';
    $('backup-btn').classList.replace('btn-danger', 'btn-secondary');
    $('sync-indicator').style.display = 'none';
    state.backupProgress.running = false;
    renderQueue();
    showToast('Backup stopped.', '');
  }

  if (msg.type === 'BACKUP_FAILED') {
    isManualBackupRunning = false;
    $('backup-btn').textContent = 'Backup';
    $('backup-btn').classList.replace('btn-danger', 'btn-secondary');
    $('sync-indicator').style.display = 'none';
    state.backupProgress.running = false;
    renderQueue();
    showToast(`Backup failed: ${msg.error || 'Unknown error'}`, 'error');
  }

  if (msg.type === 'SYNC_COMPLETE') {
    getStorageLocal(['stats', 'syncHistory']).then(data => {
      state.stats = data.stats || {};
      state.history = data.syncHistory || [];
      renderStats();
      renderHistory();
      renderQueue();
      $('sync-indicator').style.display = 'none';
      showToast(`Synced: ${msg.problem.id}. ${msg.problem.title}`, 'success');
    });
  }

  if (msg.type === 'SYNC_FAILED') {
    $('sync-indicator').style.display = 'none';
    renderQueue();
    showToast(`Sync failed: ${msg.error}`, 'error');
  }
});

function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => resolve(res || {}));
  });
}

function getStorageLocal(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, resolve);
  });
}

function formatTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return Math.floor(diff / 86400000) + 'd ago';
}

function escHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function safeClassName(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 1000000) : 0;
}

function safeImageUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && (url.hostname === 'avatars.githubusercontent.com' || url.hostname.endsWith('.githubusercontent.com'))) {
      return url.href;
    }
  } catch (e) {}
  return '';
}

function showToast(msg, type = '') {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'show ' + type;
  setTimeout(() => { t.className = ''; }, 3000);
}

init();
setInterval(refreshAuthStatus, 2500);
