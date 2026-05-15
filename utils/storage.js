// Storage utility helpers

/**
 * Core Storage Wrapper
 * Note: githubToken is handled separately via chrome.storage.session for security.
 */
export const Storage = {
  async get(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.get(keys, resolve);
    });
  },

  async set(data) {
    return new Promise((resolve) => {
      chrome.storage.local.set(data, resolve);
    });
  },

  async remove(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.remove(keys, resolve);
    });
  }
};

export const DEFAULT_SETTINGS = {
  autoSync: true,
  syncOnlyAccepted: true,
  folderOrganization: 'topic', // 'topic' | 'difficulty' | 'language' | 'flat'
  namingStyle: 'padded',       // 'padded' | 'plain' | 'slug'
  includeDifficulty: true,
  commitTemplate: 'Solved: {id}. {title} [{language}]',
  branch: 'main',
  repoName: 'LeetCode-Solutions',
  autoCreateRepo: true,
  createPrivateRepo: false,
  updateReadme: true,
  notifySuccess: true,
  notifyError: true,
  githubClientId: '',
  githubTokenProxyUrl: ''
};

// --- Settings Management ---

export async function getSettings() {
  const data = await Storage.get(['settings']);
  return { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
}

export async function saveSettings(settings) {
  const current = await getSettings();
  await Storage.set({ settings: { ...current, ...settings } });
}

// --- Secure Token Management (Session Only) ---

/**
 * Retrieves the GitHub token from session storage.
 * This is wiped when the browser is closed.
 */
export async function getToken() {
  return new Promise((resolve) => {
    // Check session storage for the token
    chrome.storage.session.get(['githubToken'], (result) => {
      resolve(result.githubToken || null);
    });
  });
}

/**
 * Saves the GitHub token to session storage.
 */
export async function saveToken(token) {
  return new Promise((resolve) => {
    chrome.storage.session.set({ githubToken: token }, resolve);
  });
}

/**
 * Clears the GitHub token from session storage.
 */
export async function clearToken() {
  return new Promise((resolve) => {
    chrome.storage.session.remove(['githubToken'], resolve);
  });
}

// --- Data & History Tracking ---

export async function getSyncedProblems() {
  const data = await Storage.get(['syncedProblems']);
  return data.syncedProblems || {};
}

export async function markProblemSynced(problemId, metadata) {
  const synced = await getSyncedProblems();
  synced[problemId] = { ...metadata, syncedAt: Date.now() };
  await Storage.set({ syncedProblems: synced });
}

export async function getSyncHistory() {
  const data = await Storage.get(['syncHistory']);
  return (data.syncHistory || []).map(({ code, ...entry }) => entry);
}

export async function addToSyncHistory(entry) {
  const history = await getSyncHistory();
  const { code, ...safeEntry } = entry || {};
  history.unshift({ ...safeEntry, timestamp: Date.now() });
  // Keep only last 100 entries
  const trimmed = history.slice(0, 100);
  await Storage.set({ syncHistory: trimmed });
}

// --- Analytics & Stats ---

export async function getStats() {
  const data = await Storage.get(['stats']);
  return data.stats || {
    totalSynced: 0,
    easy: 0,
    medium: 0,
    hard: 0,
    languages: {},
    streak: 0,
    lastSyncDate: null
  };
}

export async function updateStats(difficulty, language) {
  const stats = await getStats();
  stats.totalSynced++;
  
  const diff = (difficulty || '').toLowerCase();
  if (diff === 'easy') stats.easy++;
  else if (diff === 'medium') stats.medium++;
  else if (diff === 'hard') stats.hard++;
  
  if (language) {
    stats.languages[language] = (stats.languages[language] || 0) + 1;
  }

  // Streak logic
  const today = new Date().toDateString();
  const lastSync = stats.lastSyncDate ? new Date(stats.lastSyncDate) : null;
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);

  if (lastSync && lastSync.toDateString() === yesterday.toDateString()) {
    stats.streak++;
  } else if (!lastSync || lastSync.toDateString() !== today) {
    stats.streak = 1;
  }
  
  stats.lastSyncDate = Date.now();
  await Storage.set({ stats });
  return stats;
}
