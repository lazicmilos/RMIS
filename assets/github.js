const API_ROOT = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }

  static async fromResponse(res) {
    let detail = '';
    try {
      detail = (await res.json()).message ?? '';
    } catch {
      // Body is not JSON; the status code is enough.
    }

    if (res.headers.get('x-ratelimit-remaining') === '0') {
      return new GitHubError('Dostignut je limit zahteva ka GitHub-u. Pokušaj ponovo za nekoliko minuta.', res.status);
    }
    const messages = {
      401: 'Token nije ispravan ili je istekao.',
      403: 'Nemaš dozvolu za ovu akciju (proveri dozvole tokena).',
      404: 'Repozitorijum ili fajl nije pronađen. Proveri da li je repozitorijum javan.',
      409: 'Repozitorijum je u međuvremenu izmenjen. Osveži stranicu i pokušaj ponovo.',
    };
    if (res.status === 422 && detail.includes('sha')) {
      return new GitHubError('Fajl sa tim imenom već postoji.', res.status);
    }
    return new GitHubError(messages[res.status] ?? `GitHub greška (${res.status})${detail ? `: ${detail}` : ''}`, res.status);
  }
}

export const encodePath = (path) => path.split('/').map(encodeURIComponent).join('/');

export class GitHubClient {
  constructor({ owner, repo, branch }, token = null) {
    this.repoPath = `/repos/${owner}/${repo}`;
    this.branch = branch;
    this.token = token;
  }

  setToken(token) {
    this.token = token;
  }

  async #request(path, { method = 'GET', body } = {}) {
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body) headers['Content-Type'] = 'application/json';

    let res;
    try {
      res = await fetch(`${API_ROOT}${path}`, { method, headers, body: body && JSON.stringify(body), cache: 'no-store' });
    } catch {
      throw new GitHubError('Nema konekcije sa GitHub-om. Proveri internet vezu.', 0);
    }
    if (!res.ok) throw await GitHubError.fromResponse(res);
    return res.status === 204 ? null : res.json();
  }

  /** All blobs in the branch, in one request (keeps us far below the anonymous rate limit). */
  async listTree() {
    const data = await this.#request(`${this.repoPath}/git/trees/${encodeURIComponent(this.branch)}?recursive=1`);
    return data.tree;
  }

  async canPush() {
    const repo = await this.#request(this.repoPath);
    return Boolean(repo.permissions?.push);
  }

  putFile(path, base64Content, message) {
    return this.#request(`${this.repoPath}/contents/${encodePath(path)}`, {
      method: 'PUT',
      body: { message, content: base64Content, branch: this.branch },
    });
  }

  deleteFile(path, sha, message) {
    return this.#request(`${this.repoPath}/contents/${encodePath(path)}`, {
      method: 'DELETE',
      body: { message, sha, branch: this.branch },
    });
  }
}
