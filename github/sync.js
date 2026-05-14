// Sync orchestrator — coordinates GitHub uploads

import { GitHubAPI } from './api.js';
import { getToken, getSettings, markProblemSynced, addToSyncHistory, updateStats } from '../utils/storage.js';
import { getFilePath, formatCommitMessage, generateFileHeader, generateReadmeContent } from '../utils/naming.js';

export class SyncManager {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.api = null;
    this.owner = null;
  }

  async init() {
    const token = await getToken();
    if (!token) throw new Error('No GitHub token found. Please connect your GitHub account.');
    this.api = new GitHubAPI(token);
    const { login } = await this.api.getUser();
    this.owner = login;
    return this;
  }

  async syncProblem(problem) {
    if (!this.api) await this.init();
    const settings = await getSettings();

    const repoName = settings.repoName || 'LeetCode-Solutions';
    const branch = settings.branch || 'main';

    // Ensure repo exists
    await this.api.ensureRepo(this.owner, repoName, false);

    // Build code with header
    const header = generateFileHeader(problem);
    const fullCode = header + (problem.code || '');

    // Get file path
    const filePath = getFilePath(problem, settings);

    // Commit message
    const commitMsg = formatCommitMessage(
      settings.commitTemplate || 'Solved: {id}. {title} [{language}]',
      problem
    );

    // Upload solution
    await this.api.createOrUpdateFile(
      this.owner,
      repoName,
      filePath,
      fullCode,
      commitMsg,
      branch
    );

    // Update README
    const stats = await updateStats(problem.difficulty, problem.language);
    const readmeContent = generateReadmeContent(stats, repoName);
    await this.api.createOrUpdateFile(
      this.owner,
      repoName,
      'README.md',
      readmeContent,
      `chore: update README stats`,
      branch
    );

    // Record sync
    await markProblemSynced(problem.id, {
      title: problem.title,
      language: problem.language,
      filePath,
      difficulty: problem.difficulty
    });

    await addToSyncHistory({
      id: problem.id,
      title: problem.title,
      language: problem.language,
      difficulty: problem.difficulty,
      filePath,
      repoName,
      status: 'success'
    });

    return { filePath, repoName, owner: this.owner };
  }

  async enqueue(problem) {
    this.queue.push(problem);
    if (!this.processing) {
      this.processQueue();
    }
  }

  async processQueue() {
    this.processing = true;
    while (this.queue.length > 0) {
      const problem = this.queue.shift();
      try {
        const result = await this.syncProblem(problem);
        chrome.runtime.sendMessage({
          type: 'SYNC_SUCCESS',
          problem,
          result
        });

        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icons/icon48.png',
          title: '✅ LeetCode Synced!',
          message: `${problem.id}. ${problem.title} → ${result.repoName}/${result.filePath}`
        });
      } catch (err) {
        console.error('[LeetSync] Sync failed:', err);
        await addToSyncHistory({
          id: problem.id,
          title: problem.title,
          language: problem.language,
          status: 'failed',
          error: err.message
        });

        chrome.runtime.sendMessage({
          type: 'SYNC_ERROR',
          problem,
          error: err.message
        });

        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icons/icon48.png',
          title: '❌ Sync Failed',
          message: `${problem.title}: ${err.message}`
        });
      }
    }
    this.processing = false;
  }
}

export const syncManager = new SyncManager();
