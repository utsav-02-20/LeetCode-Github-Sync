// Sync orchestrator — coordinates GitHub uploads

import { GitHubAPI } from './api.js';
import { getToken, getSettings, markProblemSynced, addToSyncHistory, updateStats } from '../utils/storage.js';
import { getFilePath, formatCommitMessage, generateFileHeader, generateReadmeContent } from '../utils/naming.js';

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

    // Ensure repo exists (or require it if auto-create is disabled)
    if (settings.autoCreateRepo === false) {
      await this.api.getRepo(this.owner, repoName);
    } else {
      await this.api.ensureRepo(this.owner, repoName, settings.createPrivateRepo === true, this.owner);
    }

    // Build code with header
    const header = generateFileHeader(problem);
    const updateMarker = getProblemUpdateMarker(problem);
    const fullCode = `${header}/* LeetSync Update Marker: ${updateMarker} */\n${problem.code || ''}`;

    // Get file path
    const filePath = getFilePath(problem, settings);

    // Commit message
    const commitMsg = formatCommitMessage(
      settings.commitTemplate || 'Solved: {id}. {title} [{language}]',
      problem
    );

    // Upload solution
    const fileResult = await this.api.appendOrSkipFile(
      this.owner,
      repoName,
      filePath,
      fullCode,
      commitMsg,
      branch,
      { marker: updateMarker, skipIfContains: problem.code || '' }
    );

    if (fileResult?.skipped) {
      await markProblemSynced(problem.id, {
        title: problem.title,
        language: problem.language,
        filePath,
        difficulty: problem.difficulty,
        updateMarker,
        skipped: true
      });

      await addToSyncHistory({
        id: problem.id,
        title: problem.title,
        language: problem.language,
        difficulty: problem.difficulty,
        filePath,
        repoName,
        status: 'skipped',
        updateMarker,
        skipped: true
      });

      return { filePath, repoName, owner: this.owner, skipped: true };
    }

    // Update README
    const stats = await updateStats(problem.difficulty, problem.language);
    let readmeWarning = null;
    if (settings.updateReadme !== false) {
      const readmeContent = generateReadmeContent(stats, repoName);
      try {
        await this.api.createOrUpdateFile(
          this.owner,
          repoName,
          'README.md',
          readmeContent,
          `chore: update README stats`,
          branch
        );
      } catch (error) {
        readmeWarning = error.message || 'README update failed';
        console.warn('[LeetSync] README update skipped:', error);
      }
    }

    // Record sync
    await markProblemSynced(problem.id, {
      title: problem.title,
      language: problem.language,
      filePath,
      difficulty: problem.difficulty,
      updateMarker,
      skipped: !!fileResult?.skipped
    });

    await addToSyncHistory({
      id: problem.id,
      title: problem.title,
      language: problem.language,
      difficulty: problem.difficulty,
      filePath,
      repoName,
      status: 'success',
      updateMarker,
      skipped: !!fileResult?.skipped
    });

    return { filePath, repoName, owner: this.owner, readmeWarning, skipped: !!fileResult?.skipped };
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
