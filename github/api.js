// GitHub REST API integration

const GITHUB_API = 'https://api.github.com';

function encodeContentPath(path) {
  return String(path || '')
    .split('/')
    .map(part => encodeURIComponent(part))
    .join('/');
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

  async createRepo(name, isPrivate = false) {
    return this.request('POST', '/user/repos', {
      name,
      description: 'LeetCode solutions auto-synced via Chrome Extension',
      private: isPrivate,
      auto_init: true
    });
  }

  async ensureRepo(owner, repoName, isPrivate = false) {
    try {
      return await this.getRepo(owner, repoName);
    } catch (e) {
      if (e.status === 404) {
        return await this.createRepo(repoName, isPrivate);
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

  async createOrUpdateFile(owner, repo, path, content, message, branch = 'main') {
    const existing = await this.getFile(owner, repo, path, branch);
    const encoded = btoa(unescape(encodeURIComponent(content)));

    const body = {
      message,
      content: encoded,
      branch
    };

    if (existing && existing.sha) {
      body.sha = existing.sha;
    }

    return this.request('PUT', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeContentPath(path)}`, body);
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
