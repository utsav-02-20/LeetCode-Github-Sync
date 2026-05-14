// Settings page script

const $ = id => document.getElementById(id);
let unsaved = false;

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  const data = await getStorage(['settings', 'stats', 'syncHistory']);
  const status = await sendMessage({ type: 'GET_STATUS' });
  const settings = data.settings || {};
  const stats = data.stats || {};
  const history = data.syncHistory || [];

  // Populate settings
  $('repo-name').value = settings.repoName || 'LeetCode-Solutions';
  $('branch').value = settings.branch || 'main';
  $('auto-create').checked = settings.autoCreateRepo !== false;
  $('s-auto-sync').checked = settings.autoSync !== false;
  $('s-accepted-only').checked = settings.syncOnlyAccepted !== false;
  $('s-folder-org').value = settings.folderOrganization || 'topic';
  $('s-naming').value = settings.namingStyle || 'padded';
  $('s-include-diff').checked = settings.includeDifficulty || false;
  $('s-commit-tmpl').value = settings.commitTemplate || 'Solved: {id}. {title} [{language}]';
  $('github-client-id').value = settings.githubClientId || '';
  $('github-token-proxy-url').value = settings.githubTokenProxyUrl || '';
  $('oauth-callback-url').value = getOAuthRedirectUrl();

  // Auth state
  if (status.connected && status.user) {
    showConnected(status.user);
  } else {
    showDisconnected();
  }

  // Analytics
  renderAnalytics(stats);

  // History
  renderHistory(history);

  // Mark settings as clean after load
  setTimeout(() => {
    document.querySelectorAll('input, select').forEach(el => {
      if (el.id === 'github-pat') return;
      el.addEventListener('change', markUnsaved);
      el.addEventListener('input', markUnsaved);
    });
  }, 100);
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

function showConnected(user) {
  $('gh-connected').style.display = 'block';
  $('gh-disconnected').style.display = 'none';
  $('gh-avatar').src = safeImageUrl(user.avatar_url);
  $('gh-login').textContent = user.login;
}

function showDisconnected() {
  $('gh-connected').style.display = 'none';
  $('gh-disconnected').style.display = 'block';
}

$('connect-btn').addEventListener('click', async () => {
  try {
    await saveOAuthSettings();
  } catch (e) {
    showToast(e.message, 'error');
    return;
  }
  $('connect-btn').disabled = true;
  $('connect-btn').textContent = 'Opening GitHub...';
  const res = await sendMessage({ type: 'INITIATE_LOGIN' });
  if (res.valid) {
    showConnected(res.user);
    showToast('Connected as ' + res.user.login, 'success');
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
    showConnected(res.user);
    showToast('Connected as ' + res.user.login, 'success');
  } else {
    showToast('PAT login failed: ' + (res.error || 'Token could not be validated'), 'error');
  }

  $('connect-pat-btn').disabled = false;
  $('connect-pat-btn').textContent = 'Connect with PAT';
});

$('disconnect-btn').addEventListener('click', async () => {
  if (!confirm('Disconnect from GitHub?')) return;
  await sendMessage({ type: 'DISCONNECT' });
  showDisconnected();
  showToast('Disconnected');
});

$('save-oauth-btn').addEventListener('click', async () => {
  try {
    await saveOAuthSettings();
    showToast('OAuth settings saved', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  }
});

$('copy-callback-btn').addEventListener('click', async () => {
  const value = $('oauth-callback-url').value;
  try {
    await navigator.clipboard.writeText(value);
    showToast('Callback URL copied', 'success');
  } catch (e) {
    $('oauth-callback-url').select();
    showToast('Callback URL selected', '');
  }
});

// ─── Tabs ─────────────────────────────────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    $(`tab-${tab}`).classList.add('active');
  });
});

// ─── Save Settings ────────────────────────────────────────────────────────────

$('save-settings-btn').addEventListener('click', async () => {
  const settings = {
    repoName: $('repo-name').value.trim() || 'LeetCode-Solutions',
    branch: $('branch').value.trim() || 'main',
    autoCreateRepo: $('auto-create').checked,
    autoSync: $('s-auto-sync').checked,
    syncOnlyAccepted: $('s-accepted-only').checked,
    folderOrganization: $('s-folder-org').value,
    namingStyle: $('s-naming').value,
    includeDifficulty: $('s-include-diff').checked,
    commitTemplate: $('s-commit-tmpl').value.trim(),
    githubClientId: $('github-client-id').value.trim(),
    githubTokenProxyUrl: $('github-token-proxy-url').value.trim()
  };

  const res = await sendMessage({ type: 'SAVE_SETTINGS', settings });
  if (!res.ok) {
    showToast('Settings save failed: ' + (res.error || 'Unknown error'), 'error');
    return;
  }
  unsaved = false;
  $('unsaved-badge').style.display = 'none';
  showToast('✅ Settings saved', 'success');
});

async function saveOAuthSettings() {
  const settings = {
    githubClientId: $('github-client-id').value.trim(),
    githubTokenProxyUrl: $('github-token-proxy-url').value.trim()
  };

  const res = await sendMessage({ type: 'SAVE_SETTINGS', settings });
  if (!res.ok) throw new Error(res.error || 'OAuth settings save failed');
  unsaved = false;
  $('unsaved-badge').style.display = 'none';
}

function markUnsaved() {
  if (!unsaved) {
    unsaved = true;
    $('unsaved-badge').style.display = 'inline';
  }
}

// ─── Analytics ────────────────────────────────────────────────────────────────

function renderAnalytics(stats) {
  const total = safeNumber(stats.totalSynced);
  $('a-total').textContent = total;
  $('a-easy').textContent = safeNumber(stats.easy);
  $('a-medium').textContent = safeNumber(stats.medium);
  $('a-hard').textContent = safeNumber(stats.hard);
  $('a-streak').textContent = safeNumber(stats.streak);

  if (stats.lastSyncDate) {
    const d = new Date(stats.lastSyncDate);
    $('a-last').textContent = d.toLocaleDateString('en', { month: 'short', day: 'numeric' });
  }

  const langs = Object.fromEntries(
    Object.entries(stats.languages || {}).map(([lang, count]) => [lang, safeNumber(count)])
  );
  const maxLang = Math.max(...Object.values(langs), 1);
  const langBars = $('lang-bars');

  if (!Object.keys(langs).length) {
    langBars.innerHTML = '<div class="empty" style="padding:20px">No data yet</div>';
    return;
  }

  langBars.innerHTML = Object.entries(langs)
    .sort(([, a], [, b]) => b - a)
    .map(([lang, count]) => `
      <div class="lang-bar-item">
        <div class="lang-name">${escHtml(lang)}</div>
        <div class="lang-track">
          <div class="lang-fill" style="width:${Math.round(count / maxLang * 100)}%"></div>
        </div>
        <div class="lang-count">${safeNumber(count)}</div>
      </div>
    `).join('');
}

// ─── History ──────────────────────────────────────────────────────────────────

function renderHistory(history) {
  const tbody = $('history-body');
  if (!history.length) {
    $('history-container').innerHTML = '<div class="empty">No sync history yet.</div>';
    return;
  }

  tbody.innerHTML = history.slice(0, 200).map(item => {
    const icon = item.status === 'success'
      ? '<span class="status-ok">✅</span>'
      : '<span class="status-err">❌</span>';
    const diff = safeClassName(item.difficulty || '');
    const time = item.timestamp ? new Date(item.timestamp).toLocaleString() : '—';
    return `
      <tr>
        <td>${icon}</td>
        <td style="max-width:240px">
          <div style="font-weight:500">${escHtml(item.id || '')}. ${escHtml(item.title || '')}</div>
          ${item.filePath ? `<div style="font-size:10px;color:var(--muted);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace">${escHtml(item.filePath)}</div>` : ''}
        </td>
        <td><span class="lang-chip">${escHtml(item.language || '')}</span></td>
        <td>${item.difficulty ? `<span class="diff-badge diff-${diff}">${escHtml(item.difficulty)}</span>` : '—'}</td>
        <td style="font-size:11px;color:var(--muted);white-space:nowrap">${time}</td>
      </tr>`;
  }).join('');
}

$('clear-history-btn').addEventListener('click', async () => {
  if (!confirm('Clear all sync history?')) return;
  await chrome.storage.local.remove(['syncHistory']);
  renderHistory([]);
  showToast('History cleared');
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getStorage(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}

function sendMessage(msg) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(msg, res => {
      if (chrome.runtime.lastError) {
        resolve({});
        return;
      }
      resolve(res || {});
    });
  });
}

function getOAuthRedirectUrl() {
  if (chrome.identity?.getRedirectURL) {
    return chrome.identity.getRedirectURL();
  }
  return `https://${chrome.runtime.id}.chromiumapp.org/`;
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
