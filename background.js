import { GitHubAPI, isRateLimited, isUnauthorized } from './github/api.js';
import { Storage, getToken, saveToken, clearToken, getSettings, saveSettings, addToSyncHistory, updateStats, markProblemSynced } from './utils/storage.js';
import { getFilePath, formatCommitMessage, generateFileHeader, generateReadmeContent } from './utils/naming.js';

// ─── State ────────────────────────────────────────────────────────────────────

let syncQueue = [];
let isSyncing = false;
let cancelBackupFlag = false;
let currentSyncProblem = null;
let backupProgress = { running: false, current: 0, total: 0 };
const MAX_CODE_LENGTH = 500_000;
const MAX_QUEUE_LENGTH = 25;
const EXTENSION_ORIGIN = `chrome-extension://${chrome.runtime.id}`;

// ─── OAuth Configuration ──────────────────────────────────────────────────────
const REDIRECT_URL = chrome.identity.getRedirectURL();

async function getOAuthConfig() {
  const settings = sanitizeSettings(await getSettings());
  return {
    clientId: (settings.githubClientId || '').trim(),
    tokenProxyUrl: (settings.githubTokenProxyUrl || '').trim()
  };
}

function getOAuthSetupError(config) {
  if (!config.clientId) {
    return `GitHub OAuth is not configured. Open Settings > GitHub, enter your OAuth Client ID, and add this callback URL to your GitHub OAuth app: ${REDIRECT_URL}`;
  }

  if (!config.tokenProxyUrl) {
    return 'GitHub OAuth token exchange is not configured. Set the token proxy URL in GitHub settings.';
  }

  const proxyError = validateTokenProxyUrl(config.tokenProxyUrl);
  if (proxyError) return proxyError;

  return null;
}

function validateTokenProxyUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch (e) {
    return 'Token proxy URL must be a valid HTTPS URL.';
  }

  if (url.protocol !== 'https:') return 'Token proxy URL must use HTTPS.';
  if (url.username || url.password) return 'Token proxy URL must not contain credentials.';
  if (url.hash) return 'Token proxy URL must not contain a URL fragment.';
  if (!url.hostname.endsWith('.vercel.app')) {
    return 'Token proxy host is not allowed by the extension manifest. Use a vercel.app HTTPS endpoint or update host_permissions intentionally.';
  }

  return null;
}

function isExtensionPage(sender) {
  if (sender?.id && sender.id !== chrome.runtime.id) return false;
  const senderUrl = sender?.url || sender?.tab?.url || '';
  return !senderUrl || senderUrl.startsWith(EXTENSION_ORIGIN);
}

function isTrustedLeetCodeSender(sender) {
  let url;
  try {
    url = new URL(sender?.tab?.url || sender?.url || '');
  } catch (e) {
    return false;
  }
  return url.protocol === 'https:' && url.hostname === 'leetcode.com';
}

function cleanText(value, maxLength = 200) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function cleanSlug(value) {
  return cleanText(value, 120).toLowerCase().replace(/[^a-z0-9-]/g, '');
}

function cleanEnum(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function cleanRepoName(value) {
  const raw = cleanText(value, 160);
  if (!raw) return 'LeetCode-Solutions';

  const parts = raw.split('/').map(s => s.trim()).filter(Boolean);
  if (parts.length === 1) {
    const repo = parts[0];
    if (!/^[A-Za-z0-9._-]+$/.test(repo)) return 'LeetCode-Solutions';
    if (repo === '.' || repo === '..' || repo.endsWith('.git')) return 'LeetCode-Solutions';
    return repo;
  }

  if (parts.length === 2) {
    const [owner, repo] = parts;
    if (!/^[A-Za-z0-9._-]+$/.test(owner)) return 'LeetCode-Solutions';
    if (!/^[A-Za-z0-9._-]+$/.test(repo)) return 'LeetCode-Solutions';
    if (owner === '.' || owner === '..' || repo === '.' || repo === '..' || repo.endsWith('.git')) return 'LeetCode-Solutions';
    return `${owner}/${repo}`;
  }

  return 'LeetCode-Solutions';
}

function parseRepoTarget(repoSetting, fallbackOwner) {
  const normalized = cleanRepoName(repoSetting || 'LeetCode-Solutions');
  const parts = normalized.split('/');
  if (parts.length === 2) return { owner: parts[0], repo: parts[1], full: normalized };
  return { owner: fallbackOwner, repo: normalized, full: `${fallbackOwner}/${normalized}` };
}

function cleanBranch(value) {
  const branch = cleanText(value, 120);
  if (!branch || branch.includes('..') || branch.includes('\\') || branch.startsWith('/') || branch.endsWith('/')) return 'main';
  if (/[\s~^:?*[\\\]]/.test(branch) || branch.endsWith('.lock')) return 'main';
  return branch;
}

function sanitizeSettings(settings = {}) {
  return {
    autoSync: settings.autoSync !== false,
    syncOnlyAccepted: settings.syncOnlyAccepted !== false,
    folderOrganization: cleanEnum(settings.folderOrganization, ['topic', 'difficulty', 'language', 'flat'], 'topic'),
    namingStyle: cleanEnum(settings.namingStyle, ['padded', 'plain', 'slug'], 'padded'),
    includeDifficulty: settings.includeDifficulty !== false,
    commitTemplate: cleanText(settings.commitTemplate || 'Solved: {id}. {title} [{language}]', 200),
    branch: cleanBranch(settings.branch || 'main'),
    repoName: cleanRepoName(settings.repoName || 'LeetCode-Solutions'),
    autoCreateRepo: settings.autoCreateRepo !== false,
    createPrivateRepo: settings.createPrivateRepo === true,
    updateReadme: settings.updateReadme !== false,
    notifySuccess: settings.notifySuccess !== false,
    notifyError: settings.notifyError !== false,
    githubClientId: cleanText(settings.githubClientId || '', 120).replace(/[^A-Za-z0-9_-]/g, ''),
    githubTokenProxyUrl: cleanText(settings.githubTokenProxyUrl || '', 500)
  };
}

function sanitizeSettingsPatch(settings = {}) {
  const full = sanitizeSettings({ ...settings });
  const patch = {};
  for (const key of Object.keys(settings)) {
    if (Object.prototype.hasOwnProperty.call(full, key)) {
      patch[key] = full[key];
    }
  }
  return patch;
}

function getPublicSettings(settings = {}) {
  const { githubClientId, githubTokenProxyUrl, ...safeSettings } = settings;
  return safeSettings;
}

function getPublicUser(user) {
  return user ? { login: cleanText(user.login, 120), avatar_url: user.avatar_url } : null;
}

async function cacheGithubUser(user) {
  const publicUser = getPublicUser(user);
  if (publicUser) await Storage.set({ githubUser: publicUser });
  return publicUser;
}

function sanitizeProblem(problem = {}) {
  const code = String(problem.code || '');
  if (!code || code.length > MAX_CODE_LENGTH) return null;

  const id = cleanText(problem.id, 40).replace(/[^A-Za-z0-9._-]/g, '');
  const slug = cleanSlug(problem.slug);
  if (!id || !slug) return null;

  const difficulty = cleanEnum(problem.difficulty, ['Easy', 'Medium', 'Hard'], null);
  const tags = Array.isArray(problem.tags)
    ? problem.tags.slice(0, 20).map(tag => cleanText(tag, 60)).filter(Boolean)
    : [];

  return {
    id,
    title: cleanText(problem.title || 'Unknown Problem', 200),
    slug,
    difficulty,
    tags,
    language: cleanText(problem.language || 'Unknown', 40),
    runtime: cleanText(problem.runtime || '', 40),
    memory: cleanText(problem.memory || '', 40),
    submissionId: cleanText(problem.submissionId || '', 80),
    submittedAt: cleanText(problem.submittedAt || '', 80),
    code
  };
}

function summarizeProblem(problem = {}) {
  return {
    id: problem.id,
    title: problem.title,
    difficulty: problem.difficulty,
    language: problem.language,
    slug: problem.slug
  };
}

function hashText(value = '') {
  let hash = 0;
  const text = String(value);
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function getProblemUpdateMarker(problem = {}) {
  if (problem.submissionId) return `submission:${problem.submissionId}`;
  if (problem.submittedAt) return `submitted:${problem.submittedAt}`;
  return `code:${hashText(problem.code || '')}`;
}

/**
 * Initiates the GitHub OAuth flow using chrome.identity.
 */
async function launchOAuthFlow() {
  const config = await getOAuthConfig();
  const setupError = getOAuthSetupError(config);
  if (setupError) throw new Error(setupError);

  const state = crypto.randomUUID();
  const authUrl = new URL('https://github.com/login/oauth/authorize');
  authUrl.searchParams.set('client_id', config.clientId);
  authUrl.searchParams.set('scope', 'repo read:user');
  authUrl.searchParams.set('redirect_uri', REDIRECT_URL);
  authUrl.searchParams.set('state', state);

  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({
      url: authUrl.toString(),
      interactive: true
    }, async (responseUrl) => {
      if (chrome.runtime.lastError || !responseUrl) {
        const message = chrome.runtime.lastError?.message || 'Authorization failed.';
        return reject(new Error(
          message.includes('Authorization page could not be loaded')
            ? `GitHub authorization page could not be loaded. Check that your saved OAuth Client ID is correct and your GitHub OAuth app callback URL is ${REDIRECT_URL}`
            : message
        ));
      }

      const url = new URL(responseUrl);
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      if (!code) return reject(new Error('No code returned from GitHub.'));
      if (returnedState !== state) return reject(new Error('OAuth state mismatch.'));

      try {
        const token = await exchangeCodeForToken(code, config.tokenProxyUrl);
        await saveToken(token); // Ensure utils/storage.js uses chrome.storage.session
        
        const api = new GitHubAPI(token);
        const user = await api.getUser();
        const publicUser = await cacheGithubUser(user);
        
        resolve({ valid: true, user: publicUser });
      } catch (err) {
        reject(err);
      }
    });
  });
}

async function exchangeCodeForToken(code, tokenProxyUrl) {
  const res = await fetch(tokenProxyUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, redirect_uri: REDIRECT_URL })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Token exchange failed');
  if (!data.access_token || typeof data.access_token !== 'string') {
    throw new Error('Token exchange response did not include an access token.');
  }
  return data.access_token;
}

function sanitizePat(value) {
  const token = String(value || '').trim();
  if (!token || token.length < 20 || token.length > 255) return null;
  if (/[\s\u0000-\u001f\u007f]/.test(token)) return null;
  return token;
}

async function connectWithPat(rawToken) {
  const token = sanitizePat(rawToken);
  if (!token) {
    throw new Error('Enter a valid GitHub personal access token.');
  }

  const api = new GitHubAPI(token);
  const user = await api.getUser();
  await saveToken(token);
  const publicUser = await cacheGithubUser(user);

  return { valid: true, user: publicUser };
}

// ─── Sync Queue ───────────────────────────────────────────────────────────────

async function processSyncQueue() {
  if (isSyncing || syncQueue.length === 0) return;
  isSyncing = true;
  broadcastQueueUpdate();

  try {
    while (syncQueue.length > 0 && !cancelBackupFlag) {
      const { problem } = syncQueue.shift();
      currentSyncProblem = summarizeProblem(problem);
      broadcastQueueUpdate();
      try {
        const result = await syncToGitHub(problem);
        if (result) {
          notifySuccess(problem, result);
          broadcastToPopup({ type: 'SYNC_COMPLETE', problem: summarizeProblem(problem), result });
        }
      } catch (err) {
        console.error('[LeetSync BG] Sync error:', err);
        notifyError(problem, err);
        broadcastToPopup({ type: 'SYNC_FAILED', problem: summarizeProblem(problem), error: err.message });

        await addToSyncHistory({
          id: problem.id,
          title: problem.title,
          language: problem.language,
          status: 'failed',
          error: err.message
        });
      }
      currentSyncProblem = null;
      broadcastQueueUpdate();
    }
  } finally {
    isSyncing = false;
    cancelBackupFlag = false;
    currentSyncProblem = null;
    broadcastQueueUpdate();
  }
}

// ─── Remote Log (Unicode Safe) ────────────────────────────────────────────────

async function getRemoteLog(api, owner, repo, branch) {
  try {
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/sync_log.json?ref=${encodeURIComponent(branch)}`;
    const res = await fetch(url, {
      headers: { 'Authorization': `token ${api.token}` }
    });
    if (!res.ok) return { last_sync: 0, problems: {} };
    
    const data = await res.json();
    if (!data.content) return { last_sync: 0, problems: {} };

    // Decode Base64 with Unicode/UTF-8 support
    const base64 = data.content.replace(/\s/g, '');
    const decoded = decodeURIComponent(
      atob(base64).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')
    );
    return JSON.parse(decoded);
  } catch (e) {
    return { last_sync: 0, problems: {} };
  }
}

// ─── Core Sync Logic ──────────────────────────────────────────────────────────

async function syncToGitHub(problem) {
  const token = await getToken();
  if (!token) throw new Error('Not connected to GitHub.');

  const settings = sanitizeSettings(await getSettings());
  const api = new GitHubAPI(token);

  const user = await api.getUser();
  const repoTarget = parseRepoTarget(settings.repoName, user.login);
  const owner = repoTarget.owner;
  const repoName = repoTarget.repo;
  const branch = settings.branch || 'main';

  if (settings.autoCreateRepo) {
    await api.ensureRepo(owner, repoName, settings.createPrivateRepo === true, user.login);
  } else {
    await api.getRepo(owner, repoName);
  }

  const header = generateFileHeader(problem);
  const filePath = getFilePath(problem, settings);
  const commitMsg = formatCommitMessage(settings.commitTemplate, problem);
  const updateMarker = getProblemUpdateMarker(problem);
  const fullCode = `${header}/* LeetSync Update Marker: ${updateMarker} */\n${problem.code || ''}`;

  const fileResult = await api.appendOrSkipFile(owner, repoName, filePath, fullCode, commitMsg, branch, {
    marker: updateMarker,
    skipIfContains: problem.code || ''
  });

  if (fileResult?.skipped) {
    await markProblemSynced(problem.id, {
      title: problem.title,
      language: problem.language,
      difficulty: problem.difficulty,
      filePath,
      updateMarker,
      skipped: true
    });

    await addToSyncHistory({
      id: problem.id,
      title: problem.title,
      language: problem.language,
      difficulty: problem.difficulty,
      repoName,
      status: 'skipped',
      filePath,
      updateMarker,
      skipped: true
    });

    return { filePath, repoName, owner, skipped: true };
  }

  let readmeWarning = null;
  const stats = await updateStats(problem.difficulty, problem.language);
  if (settings.updateReadme !== false) {
    const readmeContent = generateReadmeContent(stats, repoName);
    try {
      await api.createOrUpdateFile(owner, repoName, 'README.md', readmeContent, 'chore: update README', branch);
    } catch (error) {
      readmeWarning = error.message || 'README update failed';
      console.warn('[LeetSync BG] README update skipped:', error);
    }
  }

  await markProblemSynced(problem.id, {
    title: problem.title,
    language: problem.language,
    difficulty: problem.difficulty,
    filePath,
    updateMarker,
    skipped: !!fileResult?.skipped
  });

  await addToSyncHistory({
    id: problem.id,
    title: problem.title,
    language: problem.language,
    difficulty: problem.difficulty,
    repoName,
    status: 'success',
    filePath,
    updateMarker,
    skipped: !!fileResult?.skipped
  });

  return { filePath, repoName, owner, readmeWarning, skipped: !!fileResult?.skipped };
}

// ─── Backup Logic ─────────────────────────────────────────────────────────────

async function handleFullBackup(sendResponse) {
  if (isSyncing) {
    sendResponse({ ok: false, error: 'A sync process is already running.' });
    return;
  }
  isSyncing = true;
  cancelBackupFlag = false;
  backupProgress = { running: true, current: 0, total: 0 };
  broadcastQueueUpdate();

  try {
    const token = await getToken();
    if (!token) {
      sendResponse({ ok: false, error: 'Not connected to GitHub.' });
      return;
    }
    sendResponse({ ok: true });
    const settings = sanitizeSettings(await getSettings());
    const api = new GitHubAPI(token);
    const user = await api.getUser();
    const repoTarget = parseRepoTarget(settings.repoName, user.login);
    if (settings.autoCreateRepo) {
      await api.ensureRepo(repoTarget.owner, repoTarget.repo, settings.createPrivateRepo === true, user.login);
    } else {
      await api.getRepo(repoTarget.owner, repoTarget.repo);
    }
    
    const remoteLog = await getRemoteLog(api, repoTarget.owner, repoTarget.repo, settings.branch);
    const metadataMap = await fetchProblemMetadata();
    
    let submissionsToSync = [];
    let offset = 0;
    let hasNext = true;

    while (hasNext && !cancelBackupFlag) {
      const res = await fetch(`https://leetcode.com/api/submissions/?offset=${offset}&limit=20`);
      if (!res.ok) break;
      const data = await res.json();
      
      for (const sub of data.submissions_dump) {
        if (sub.status_display !== 'Accepted') continue;

        const meta = metadataMap[sub.title] || {};
        const probId = meta.id || '0000';
        const logEntry = remoteLog.problems[probId];

        if (!logEntry || sub.id > logEntry.submission_id) {
          submissionsToSync.push({ sub, meta });
        } else {
          hasNext = false; 
          break;
        }
      }
      if (!data.has_next) hasNext = false;
      offset += 20;
      await new Promise(r => setTimeout(r, 400));
    }

    if (cancelBackupFlag) {
      broadcastToPopup({ type: 'BACKUP_STOPPED' });
      return;
    }

    if (submissionsToSync.length === 0) {
      broadcastToPopup({ type: 'BACKUP_COMPLETE', total: 0 });
      backupProgress = { running: false, current: 0, total: 0 };
      broadcastQueueUpdate();
      return;
    }

    submissionsToSync = Array.from(
      submissionsToSync
        .reduce((latestByProblem, item) => {
          const problemId = item.meta.id || item.sub.title;
          const current = latestByProblem.get(problemId);
          if (!current || Number(item.sub.id) > Number(current.sub.id)) {
            latestByProblem.set(problemId, item);
          }
          return latestByProblem;
        }, new Map())
        .values()
    ).sort((a, b) => Number(a.sub.id) - Number(b.sub.id));

    broadcastToPopup({ type: 'BACKUP_STARTED', total: submissionsToSync.length });
    backupProgress = { running: true, current: 0, total: submissionsToSync.length };
    broadcastQueueUpdate();

    for (let i = 0; i < submissionsToSync.length; i++) {
      if (cancelBackupFlag) break;
      const item = submissionsToSync[i];
      const { sub, meta } = item;
      const problemObj = {
        id: meta.id || '0000',
        title: sub.title,
        slug: meta.slug,
        difficulty: meta.difficulty,
        language: sub.lang,
        code: sub.code,
        submissionId: sub.id,
        submittedAt: sub.timestamp
      };

      await syncToGitHub(problemObj);
      backupProgress.current = i + 1;
      broadcastQueueUpdate();
      broadcastToPopup({
        type: 'BACKUP_PROGRESS',
        current: i + 1,
        total: submissionsToSync.length,
        problem: summarizeProblem(problemObj)
      });

      remoteLog.problems[problemObj.id] = {
        submission_id: sub.id,
        updated_at: new Date().toISOString()
      };
    }

    if (cancelBackupFlag) {
      broadcastToPopup({ type: 'BACKUP_STOPPED' });
      backupProgress = { running: false, current: backupProgress.current, total: backupProgress.total };
      broadcastQueueUpdate();
      return;
    }

    remoteLog.last_sync = Date.now();
    await api.createOrUpdateFile(repoTarget.owner, repoTarget.repo, 'sync_log.json', JSON.stringify(remoteLog, null, 2), 'chore: update sync log', settings.branch);
    broadcastToPopup({ type: 'BACKUP_COMPLETE', total: submissionsToSync.length });
    backupProgress = { running: false, current: submissionsToSync.length, total: submissionsToSync.length };
    broadcastQueueUpdate();

  } catch (error) {
    console.error('[LeetSync BG] Backup failed:', error);
    broadcastToPopup({ type: 'BACKUP_FAILED', error: error.message });
    backupProgress = { running: false, current: backupProgress.current, total: backupProgress.total };
    broadcastQueueUpdate();
  } finally {
    isSyncing = false;
    cancelBackupFlag = false;
    currentSyncProblem = null;
    broadcastQueueUpdate();
    processSyncQueue();
  }
}

async function fetchProblemMetadata() {
  try {
    const res = await fetch('https://leetcode.com/api/problems/all/');
    if (!res.ok) return {};
    const data = await res.json();
    const map = {};
    const diffMap = { 1: 'Easy', 2: 'Medium', 3: 'Hard' };
    
    data.stat_status_pairs.forEach(pair => {
      map[pair.stat.question__title] = {
        id: pair.stat.frontend_question_id.toString().padStart(4, '0'),
        slug: pair.stat.question__title_slug,
        difficulty: diffMap[pair.difficulty.level]
      };
    });
    return map;
  } catch (e) { return {}; }
}

// ─── Message Handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') {
    sendResponse({ ok: false, error: 'Invalid message.' });
    return false;
  }

  if (message.type === 'SYNC_PROBLEM') {
    if (!isTrustedLeetCodeSender(sender)) {
      sendResponse({ queued: false, error: 'Untrusted sender.' });
      return false;
    }
    handleSyncRequest(message.problem).then(sendResponse);
    return true;
  }

  if (!isExtensionPage(sender)) {
    sendResponse({ ok: false, error: 'Untrusted sender.' });
    return false;
  }

  if (message.type === 'INITIATE_LOGIN') {
    launchOAuthFlow().then(sendResponse).catch(e => sendResponse({ valid: false, error: e.message }));
    return true;
  }
  if (message.type === 'CONNECT_WITH_PAT') {
    connectWithPat(message.token).then(sendResponse).catch(e => sendResponse({ valid: false, error: e.message }));
    return true;
  }
  if (message.type === 'GET_STATUS') {
    getStatus().then(sendResponse);
    return true;
  }
  if (message.type === 'GET_OAUTH_REDIRECT_URL') {
    sendResponse({ redirectUrl: REDIRECT_URL });
    return true;
  }
  if (message.type === 'START_BACKUP') {
    handleFullBackup(sendResponse);
    return true;
  }
  if (message.type === 'STOP_BACKUP') {
    cancelBackupFlag = true;
    sendResponse({ ok: true });
    return true;
  }
  if (message.type === 'DISCONNECT') {
    Promise.all([clearToken(), Storage.remove(['githubUser'])]).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.type === 'SAVE_SETTINGS') {
    const settings = sanitizeSettingsPatch(message.settings || {});
    saveSettings(settings).then(() => sendResponse({ ok: true })).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message.type === 'TEST_REPO_ACCESS') {
    (async () => {
      const token = await getToken();
      if (!token) return sendResponse({ ok: false, error: 'Not connected to GitHub.' });
      const settings = sanitizeSettings(await getSettings());
      const api = new GitHubAPI(token);
      const user = await api.getUser();
      const repoTarget = parseRepoTarget(settings.repoName, user.login);
      const repo = await api.getRepo(repoTarget.owner, repoTarget.repo);
      const branches = await api.listBranches(repoTarget.owner, repoTarget.repo);
      return sendResponse({
        ok: true,
        repo: { name: repo.name, private: !!repo.private },
        branchExists: Array.isArray(branches) && branches.some(b => b.name === settings.branch),
        branch: settings.branch
      });
    })().catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  sendResponse({ ok: false, error: 'Unknown message type.' });
  return false;
});

async function handleSyncRequest(problem) {
  const settings = sanitizeSettings(await getSettings());
  if (!settings.autoSync) return { queued: false, error: 'Auto sync is disabled.' };
  if (syncQueue.length >= MAX_QUEUE_LENGTH) return { queued: false, error: 'Sync queue is full.' };

  const safeProblem = sanitizeProblem(problem);
  if (!safeProblem) return { queued: false, error: 'Invalid problem payload.' };

  syncQueue.push({ problem: safeProblem });
  broadcastQueueUpdate();
  processSyncQueue();
  return { queued: true };
}

async function getStatus() {
  const token = await getToken();
  const settings = sanitizeSettings(await getSettings());
  let user = null;
  if (token) {
    try {
      user = await cacheGithubUser(await new GitHubAPI(token).getUser());
    } catch (e) {}
  }
  if (!user) await Storage.remove(['githubUser']);
  return {
    connected: !!user,
    user,
    settings: getPublicSettings(settings),
    queueSize: syncQueue.length,
    syncing: isSyncing,
    queuePreview: syncQueue.slice(0, 8).map(item => summarizeProblem(item.problem)),
    currentProblem: currentSyncProblem,
    backupProgress
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function notifySuccess(problem, result) {
  getSettings().then(raw => {
    const settings = sanitizeSettings(raw);
    if (settings.notifySuccess === false) return;
    chrome.notifications.create(`sync_${problem.id}_${Date.now()}`, {
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: result?.skipped ? 'LeetCode Already Synced' : '✅ LeetCode Synced!',
      message: `${cleanText(problem.id, 40)}. ${cleanText(problem.title, 120)}\n→ ${cleanText(result.repoName, 100)}/${cleanText(result.filePath, 180)}`
    });
  }).catch(() => {});
}

function notifyError(problem, error) {
  getSettings().then(raw => {
    const settings = sanitizeSettings(raw);
    if (settings.notifyError === false) return;
    let msg = cleanText(error.message, 180);
    if (isUnauthorized(error)) msg = 'GitHub token expired.';
    chrome.notifications.create(`err_${Date.now()}`, {
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: '❌ Sync Failed',
      message: `${cleanText(problem?.title || 'Problem', 120)}: ${msg}`
    });
  }).catch(() => {});
}

function broadcastToPopup(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

async function broadcastQueueUpdate() {
  const status = {
    queueSize: syncQueue.length,
    syncing: isSyncing,
    queuePreview: syncQueue.slice(0, 8).map(item => summarizeProblem(item.problem)),
    currentProblem: currentSyncProblem,
    backupProgress
  };
  broadcastToPopup({
    type: 'QUEUE_UPDATE',
    queueSize: status.queueSize,
    syncing: status.syncing,
    queuePreview: status.queuePreview,
    currentProblem: status.currentProblem,
    backupProgress: status.backupProgress
  });
}

console.log('[LeetSync BG] Service worker started.');
