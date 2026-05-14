import { GitHubAPI, isRateLimited, isUnauthorized } from './github/api.js';
import { getToken, saveToken, clearToken, getSettings, saveSettings, addToSyncHistory, updateStats, markProblemSynced } from './utils/storage.js';
import { getFilePath, formatCommitMessage, generateFileHeader, generateReadmeContent } from './utils/naming.js';

// ─── State ────────────────────────────────────────────────────────────────────

let syncQueue = [];
let isSyncing = false;
let cancelBackupFlag = false;
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
  return sender?.id === chrome.runtime.id && !sender.tab && (!sender.url || sender.url.startsWith(EXTENSION_ORIGIN));
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
  const repo = cleanText(value, 100);
  if (!/^[A-Za-z0-9._-]+$/.test(repo)) return 'LeetCode-Solutions';
  if (repo === '.' || repo === '..' || repo.endsWith('.git')) return 'LeetCode-Solutions';
  return repo;
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
        
        resolve({ valid: true, user: { login: user.login, avatar_url: user.avatar_url } });
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

  return { valid: true, user: { login: user.login, avatar_url: user.avatar_url } };
}

// ─── Sync Queue ───────────────────────────────────────────────────────────────

async function processSyncQueue() {
  if (isSyncing || syncQueue.length === 0) return;
  isSyncing = true;

  try {
    while (syncQueue.length > 0 && !cancelBackupFlag) {
      const { problem } = syncQueue.shift();
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
    }
  } finally {
    isSyncing = false;
    cancelBackupFlag = false;
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
  const owner = user.login;
  const repoName = settings.repoName || 'LeetCode-Solutions';
  const branch = settings.branch || 'main';

  await api.ensureRepo(owner, repoName, false);

  const header = generateFileHeader(problem);
  const fullCode = header + (problem.code || '');
  const filePath = getFilePath(problem, settings);
  const commitMsg = formatCommitMessage(settings.commitTemplate, problem);

  await api.createOrUpdateFile(owner, repoName, filePath, fullCode, commitMsg, branch);

  const stats = await updateStats(problem.difficulty, problem.language);
  const readmeContent = generateReadmeContent(stats, repoName);
  await api.createOrUpdateFile(owner, repoName, 'README.md', readmeContent, 'chore: update README', branch);

  await markProblemSynced(problem.id, {
    title: problem.title,
    language: problem.language,
    difficulty: problem.difficulty,
    filePath
  });

  await addToSyncHistory({
    id: problem.id,
    title: problem.title,
    language: problem.language,
    difficulty: problem.difficulty,
    repoName,
    status: 'success',
    filePath
  });

  return { filePath, repoName, owner };
}

// ─── Backup Logic ─────────────────────────────────────────────────────────────

async function handleFullBackup(sendResponse) {
  if (isSyncing) {
    sendResponse({ ok: false, error: 'A sync process is already running.' });
    return;
  }
  cancelBackupFlag = false;

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
    
    const remoteLog = await getRemoteLog(api, user.login, settings.repoName, settings.branch);
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

    if (cancelBackupFlag || submissionsToSync.length === 0) return;

    submissionsToSync.reverse();
    for (const item of submissionsToSync) {
      if (cancelBackupFlag) break;
      const { sub, meta } = item;
      const problemObj = {
        id: meta.id || '0000',
        title: sub.title,
        slug: meta.slug,
        difficulty: meta.difficulty,
        language: sub.lang,
        code: sub.code,
        submissionId: sub.id
      };

      await syncToGitHub(problemObj);

      remoteLog.problems[problemObj.id] = {
        submission_id: sub.id,
        updated_at: new Date().toISOString()
      };
    }

    remoteLog.last_sync = Date.now();
    await api.createOrUpdateFile(user.login, settings.repoName, 'sync_log.json', JSON.stringify(remoteLog, null, 2), 'chore: update sync log', settings.branch);

  } catch (error) {
    console.error('[LeetSync BG] Backup failed:', error);
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
    clearToken().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.type === 'SAVE_SETTINGS') {
    const settings = sanitizeSettingsPatch(message.settings || {});
    saveSettings(settings).then(() => sendResponse({ ok: true })).catch(e => sendResponse({ ok: false, error: e.message }));
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
  processSyncQueue();
  return { queued: true };
}

async function getStatus() {
  const token = await getToken();
  const settings = sanitizeSettings(await getSettings());
  let user = null;
  if (token) {
    try {
      user = await new GitHubAPI(token).getUser();
    } catch (e) {}
  }
  return {
    connected: !!user,
    user: user ? { login: user.login, avatar_url: user.avatar_url } : null,
    settings: getPublicSettings(settings),
    queueSize: syncQueue.length,
    syncing: isSyncing
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function notifySuccess(problem, result) {
  chrome.notifications.create(`sync_${problem.id}_${Date.now()}`, {
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: '✅ LeetCode Synced!',
    message: `${cleanText(problem.id, 40)}. ${cleanText(problem.title, 120)}\n→ ${cleanText(result.repoName, 100)}/${cleanText(result.filePath, 180)}`
  });
}

function notifyError(problem, error) {
  let msg = cleanText(error.message, 180);
  if (isUnauthorized(error)) msg = 'GitHub token expired.';
  chrome.notifications.create(`err_${Date.now()}`, {
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: '❌ Sync Failed',
    message: `${cleanText(problem?.title || 'Problem', 120)}: ${msg}`
  });
}

function broadcastToPopup(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

console.log('[LeetSync BG] Service worker started.');
