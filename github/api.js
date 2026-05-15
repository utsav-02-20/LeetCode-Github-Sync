// GitHub REST API integration

const GITHUB_API = 'https://api.github.com';
const CONTENT_UPDATE_ATTEMPTS = 6;

function encodeContentPath(path) {
  return String(path || '')
    .split('/')
    .map(part => encodeURIComponent(part))
    .join('/');
}

function encodeFileContent(content) {
  return btoa(unescape(encodeURIComponent(content)));
}

function decodeFileContent(file) {
  if (!file?.content || file.encoding !== 'base64') return '';
  const base64 = file.content.replace(/\s/g, '');
  return decodeURIComponent(
    atob(base64).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')
  );
}

function buildAppendContent(existingContent, newContent, marker) {
  const separator = [
    '',
    '',
    '/*',
    ' * ------------------------------------------------------------',
    ' * LeetSync appended newer accepted solution',
    marker ? ` * LeetSync Update Marker: ${marker}` : '',
    ` * Appended At: ${new Date().toISOString()}`,
    ' * ------------------------------------------------------------',
    ' */',
    ''
  ].filter(line => line !== '').join('\n');

  return `${existingContent.replace(/\s+$/g, '')}${separator}${newContent}`;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getContentRetryDelay(attempt) {
  return 750 * (attempt + 1);
}

export class GitHubAPI {
  constructor(token) {
    this.token = token;
  }

  get headers() {
    return {
      'Authorization': `token ${this.token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/vnd.github.v3+json'
    };
  }

  async request(method, path, body = null) {
    const options = {
      method,
      headers: this.headers
    };
    if (body) options.body = JSON.stringify(body);

    const res = await fetch(`${GITHUB_API}${path}`, options);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new GitHubError(res.status, err.message || res.statusText, err);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  async getUser() {
    return this.request('GET', '/user');
  }

  async getRepo(owner, repo) {
    return this.request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
  }

  async createRepo(name, isPrivate = false, owner = null, currentUser = null) {
    const createPath = owner && currentUser && owner !== currentUser
      ? `/orgs/${encodeURIComponent(owner)}/repos`
      : '/user/repos';
    return this.request('POST', createPath, {
      name,
      description: 'LeetCode solutions auto-synced via Chrome Extension',
      private: isPrivate,
      auto_init: true
    });
  }

  async ensureRepo(owner, repoName, isPrivate = false, currentUser = null) {
    try {
      return await this.getRepo(owner, repoName);
    } catch (e) {
      if (e.status === 404) {
        try {
          return await this.createRepo(repoName, isPrivate, owner, currentUser);
        } catch (createError) {
          // If create raced with another process, try a final read before failing.
          if (createError?.status === 422) {
            try {
              return await this.getRepo(owner, repoName);
            } catch (_) {
              // fall through to enriched error below
            }
          }
          const hint = 'Auto-create failed. Check that the repo owner is your personal account and your token can create repos.';
          throw new GitHubError(
            createError?.status || 500,
            `${createError?.message || 'Repository creation failed.'} ${hint}`,
            createError?.data || {}
          );
        }
      }
      throw e;
    }
  }

  async getFile(owner, repo, path, branch = 'main') {
    const url = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeContentPath(path)}?ref=${encodeURIComponent(branch)}`;
    const res = await fetch(url, {
      headers: { 'Authorization': `token ${this.token}` }
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('File not found');
    return await res.json();
  }

  async resolveContentPath(owner, repo, path, branch = 'main') {
    const parts = String(path || '').split('/').filter(Boolean);
    if (!parts.length) return path;

    let currentPath = '';
    const resolved = [];

    for (const part of parts) {
      const listPath = currentPath ? `${currentPath}` : '';
      const url = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeContentPath(listPath)}?ref=${encodeURIComponent(branch)}`;
      const res = await fetch(url, {
        headers: { 'Authorization': `token ${this.token}` }
      });

      if (!res.ok) return path;

      const entries = await res.json();
      if (!Array.isArray(entries)) return path;

      const match = entries.find(entry => entry.name.toLowerCase() === part.toLowerCase());
      resolved.push(match ? match.name : part);
      currentPath = resolved.join('/');
    }

    return resolved.join('/');
  }

  isShaConflict(error) {
    return error?.status === 409 || /sha.*match|does not match/i.test(error?.message || '');
  }

  isAlreadyExistsConflict(error) {
    return error?.status === 422 && /already exists/i.test(error?.message || '');
  }

  async createOrUpdateFile(owner, repo, path, content, message, branch = 'main') {
    const encoded = encodeFileContent(content);
    let targetPath = await this.resolveContentPath(owner, repo, path, branch);

    for (let attempt = 0; attempt < CONTENT_UPDATE_ATTEMPTS; attempt++) {
      const existing = await this.getFile(owner, repo, targetPath, branch);
      const body = {
        message,
        content: encoded,
        branch
      };

      if (existing && existing.sha) {
        body.sha = existing.sha;
      }

      try {
        return await this.request('PUT', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeContentPath(targetPath)}`, body);
      } catch (error) {
        if (!this.isShaConflict(error) || attempt === CONTENT_UPDATE_ATTEMPTS - 1) throw error;
        targetPath = await this.resolveContentPath(owner, repo, path, branch);
        await wait(getContentRetryDelay(attempt));
      }
    }
  }

  async appendOrSkipFile(owner, repo, path, content, message, branch = 'main', options = {}) {
    let targetPath = await this.resolveContentPath(owner, repo, path, branch);
    const marker = options.marker || '';

    for (let attempt = 0; attempt < CONTENT_UPDATE_ATTEMPTS; attempt++) {
      const existing = await this.getFile(owner, repo, targetPath, branch);
      let finalContent = content;
      const body = {
        message,
        content: '',
        branch
      };

      if (existing) {
        if (existing.type && existing.type !== 'file') {
          throw new GitHubError(409, `${targetPath} already exists but is not a file.`);
        }

        const existingContent = decodeFileContent(existing);
        const skipIfContains = String(options.skipIfContains || '').trim();
        if (marker && existingContent.includes(`LeetSync Update Marker: ${marker}`)) {
          return { skipped: true, path: targetPath, sha: existing.sha };
        }

        if (skipIfContains && existingContent.includes(skipIfContains)) {
          return { skipped: true, path: targetPath, sha: existing.sha };
        }

        finalContent = buildAppendContent(existingContent, content, marker);
        if (existing.sha) body.sha = existing.sha;
      }

      body.content = encodeFileContent(finalContent);

      try {
        const result = await this.request('PUT', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeContentPath(targetPath)}`, body);
        return { skipped: false, path: targetPath, result };
      } catch (error) {
        if ((!this.isShaConflict(error) && !this.isAlreadyExistsConflict(error)) || attempt === CONTENT_UPDATE_ATTEMPTS - 1) throw error;
        targetPath = await this.resolveContentPath(owner, repo, path, branch);
        await wait(getContentRetryDelay(attempt));
      }
    }
  }

  async listBranches(owner, repo) {
    return this.request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`);
  }

  async validateToken() {
    try {
      const user = await this.getUser();
      return { valid: true, user };
    } catch (e) {
      return { valid: false, error: e.message };
    }
  }
}

export class GitHubError extends Error {
  constructor(status, message, data = {}) {
    super(message);
    this.status = status;
    this.data = data;
    this.name = 'GitHubError';
  }
}

export function isRateLimited(error) {
  return error.status === 403 && error.message.includes('rate limit');
}

export function isUnauthorized(error) {
  return error.status === 401;
}
