// Popup script

const $ = id => document.getElementById(id);

let state = { connected: false, user: null, settings: {}, stats: {}, history: [] };

// ─── Init ─────────────────────────────────────────────────────────────────────

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

  refreshAuthStatus();
}

async function refreshAuthStatus() {
  const status = await sendMessage({ type: 'GET_STATUS' });
  state.connected = !!status.connected;
  state.user = status.user || null;
  state.settings = status.settings || state.settings || {};

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
}

// ─── Stats ────────────────────────────────────────────────────────────────────

function renderStats() {
  const s = state.stats;
  const total = safeNumber(s.totalSynced);
  const easy = safeNumber(s.easy);
  const medium = safeNumber(s.medium);
  const hard = safeNumber(s.hard);

  $('stat-total').textContent = total;
  $('stat-streak').textContent = safeNumber(s.streak);

  // Today's count from history
  const today = new Date().toDateString();
  const todayCount = (state.history || []).filter(h => {
    return h.status === 'success' && new Date(h.timestamp).toDateString() === today;
  }).length;
  $('stat-today').textContent = todayCount;

  $('cnt-easy').textContent = easy;
  $('cnt-medium').textContent = medium;
  $('cnt-hard').textContent = hard;

  const pct = (n) => total > 0 ? Math.round(n / total * 100) : 0;
  $('bar-easy').style.width = pct(easy) + '%';
  $('bar-medium').style.width = pct(medium) + '%';
  $('bar-hard').style.width = pct(hard) + '%';
}

// ─── History ──────────────────────────────────────────────────────────────────

function renderHistory() {
  const list = $('sync-list');
  const history = (state.history || []).slice(0, 8);

  if (!history.length) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="icon">📭</div>
        <p>No syncs yet.<br>Solve a LeetCode problem to get started!</p>
      </div>`;
    return;
  }

  list.innerHTML = history.map(item => {
    const icon = item.status === 'success' ? '✅' : item.status === 'skipped' ? '↷' : '❌';
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

// ─── Auth ─────────────────────────────────────────────────────────────────────

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

// ─── Backup Button Logic ──────────────────────────────────────────────────────

// ─── Settings ─────────────────────────────────────────────────────────────────

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

// ─── Backup Button Logic ──────────────────────────────────────────────────────

let isManualBackupRunning = false;

$('backup-btn').addEventListener('click', async () => {
  if (isManualBackupRunning) {
    // STOP LOGIC
    await sendMessage({ type: 'STOP_BACKUP' });
    isManualBackupRunning = false;
    $('backup-btn').textContent = 'Backup';
    $('backup-btn').classList.replace('btn-danger', 'btn-secondary');
    $('sync-indicator').style.display = 'none';
    showToast('⏹️ Backup stopped.', 'info');
    return;
  }

  // START LOGIC
  if (!confirm('Start a full backup?')) return;

  isManualBackupRunning = true;
  $('backup-btn').textContent = 'Stop';
  $('backup-btn').classList.replace('btn-secondary', 'btn-danger');
  $('sync-indicator').style.display = 'flex';

  const res = await sendMessage({ type: 'START_BACKUP' });
  if (!res.ok) {
    showToast('❌ Failed: ' + res.error, 'error');
    isManualBackupRunning = false;
    $('backup-btn').textContent = 'Backup';
    $('backup-btn').classList.replace('btn-danger', 'btn-secondary');
    $('sync-indicator').style.display = 'none';
  }
});

// ─── Live Updates ─────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'BACKUP_STARTED') {
    showToast(`Backup started: ${safeNumber(msg.total)} solution(s) queued.`, '');
  }

  if (msg.type === 'BACKUP_PROGRESS') {
    $('backup-btn').textContent = `${safeNumber(msg.current)}/${safeNumber(msg.total)}`;
  }

  if (msg.type === 'BACKUP_COMPLETE') {
    isManualBackupRunning = false;
    $('backup-btn').textContent = 'Backup';
    $('backup-btn').classList.replace('btn-danger', 'btn-secondary');
    $('sync-indicator').style.display = 'none';
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
    showToast('Backup stopped.', '');
  }

  if (msg.type === 'BACKUP_FAILED') {
    isManualBackupRunning = false;
    $('backup-btn').textContent = 'Backup';
    $('backup-btn').classList.replace('btn-danger', 'btn-secondary');
    $('sync-indicator').style.display = 'none';
    showToast(`Backup failed: ${msg.error || 'Unknown error'}`, 'error');
  }

  if (msg.type === 'SYNC_COMPLETE') {
    // Refresh
    getStorageLocal(['stats', 'syncHistory']).then(data => {
      state.stats = data.stats || {};
      state.history = data.syncHistory || [];
      renderStats();
      renderHistory();
      $('sync-indicator').style.display = 'none';
      showToast(`✅ ${msg.problem.id}. ${msg.problem.title} synced!`, 'success');
    });
  }

  if (msg.type === 'SYNC_FAILED') {
    $('sync-indicator').style.display = 'none';
    showToast(`❌ Sync failed: ${msg.error}`, 'error');
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function safeClassName(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 1_000_000) : 0;
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
