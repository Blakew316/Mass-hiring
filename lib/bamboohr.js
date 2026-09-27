// Thin client for the BambooHR REST API — ported verbatim from WPI Hire
// (src/bamboohr.js). The credentials come from the Onboarding docs page (or, for
// the original team, WPI Hire's environment variables) — see lib/onboarding.js.
//
// Auth is HTTP Basic with the API key as the username and "x" as the password.
// Docs: https://documentation.bamboohr.com/docs

class BambooClient {
  constructor({ subdomain, apiKey }) {
    // Tolerate a full URL pasted as the subdomain ("https://acme.bamboohr.com"
    // or "acme.bamboohr.com" → "acme").
    this.subdomain = String(subdomain)
      .trim()
      .replace(/^https?:\/\//, '')
      .split('.')[0]
      .split('/')[0];
    this.base = `https://api.bamboohr.com/api/gateway.php/${this.subdomain}/v1`;
    this.authHeader =
      'Basic ' + Buffer.from(`${apiKey}:x`).toString('base64');
  }

  async request(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        Authorization: this.authHeader,
        Accept: 'application/json',
        ...(body && !(body instanceof FormData)
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...headers,
      },
      body:
        body instanceof FormData
          ? body
          : body !== undefined
            ? JSON.stringify(body)
            : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const hint =
        res.status === 401
          ? `BambooHR rejected the API key for “${this.subdomain}.bamboohr.com”. Double-check BAMBOOHR_API_KEY (and that the key hasn't been revoked).`
          : res.status === 403
            ? `The BambooHR API key doesn't have permission for this — the key inherits the permissions of the user who created it (Applicant Tracking access is needed for the pipeline).`
            : res.status === 404
              ? `BambooHR returned “not found” for ${this.subdomain}.bamboohr.com — check BAMBOOHR_SUBDOMAIN, and that this feature (e.g. Applicant Tracking) is enabled on your account.`
              : `BambooHR API ${method} ${path} failed: ${res.status} ${res.statusText}` +
                (text ? ` — ${text.slice(0, 300)}` : '');
      const err = new Error(hint);
      err.status = res.status;
      throw err;
    }
    if (raw) return res;
    if (res.status === 204) return null;
    const contentType = res.headers.get('content-type') || '';
    return contentType.includes('json') ? res.json() : res.text();
  }

  // ── Applicant Tracking ────────────────────────────────────────────────────

  async getJobs() {
    return this.request('/applicant_tracking/jobs?statusGroups=Open');
  }

  async getApplications({ page = 1, jobId, searchString } = {}) {
    const params = new URLSearchParams({ page: String(page) });
    if (jobId) params.set('jobId', String(jobId));
    if (searchString) params.set('searchString', searchString);
    return this.request(`/applicant_tracking/applications?${params}`);
  }

  async getApplication(id) {
    return this.request(`/applicant_tracking/applications/${id}`);
  }

  async getHiringStatuses() {
    return this.request('/applicant_tracking/statuses');
  }

  async updateApplicationStatus(applicationId, statusId) {
    return this.request(
      `/applicant_tracking/applications/${applicationId}/status`,
      { method: 'POST', body: { status: statusId } }
    );
  }

  // ── Employees ─────────────────────────────────────────────────────────────

  async getDirectory() {
    return this.request('/employees/directory');
  }

  // Creates an employee; returns the new employee id parsed from the
  // Location header (BambooHR returns 201 with no body).
  async addEmployee(fields) {
    const res = await this.request('/employees/', {
      method: 'POST',
      body: fields,
      raw: true,
    });
    const location = res.headers.get('location') || '';
    const id = location.split('/').filter(Boolean).pop();
    return { id };
  }

  async getEmployee(id, fields) {
    const params = fields ? `?fields=${encodeURIComponent(fields.join(','))}` : '';
    return this.request(`/employees/${id}${params}`);
  }

  // ── Employee files ────────────────────────────────────────────────────────

  async listEmployeeFiles(employeeId) {
    return this.request(`/employees/${employeeId}/files/view/`);
  }

  async createFileCategory(name) {
    // Body is a JSON array of category names to create.
    return this.request('/employees/files/categories/', {
      method: 'POST',
      body: [name],
    });
  }

  // Finds a file category by name (creating it if missing) and returns its id.
  async ensureFileCategory(employeeId, name) {
    const listing = await this.listEmployeeFiles(employeeId).catch(() => null);
    const categories = listing?.categories || listing?.category || [];
    const found = (Array.isArray(categories) ? categories : [categories]).find(
      (c) => (c?.name || '').toLowerCase() === name.toLowerCase()
    );
    if (found?.id) return found.id;
    await this.createFileCategory(name);
    const after = await this.listEmployeeFiles(employeeId).catch(() => null);
    const cats = after?.categories || [];
    const created = (Array.isArray(cats) ? cats : [cats]).find(
      (c) => (c?.name || '').toLowerCase() === name.toLowerCase()
    );
    return created?.id ?? null;
  }

  async uploadEmployeeFile(employeeId, { fileName, buffer, categoryId, share = true }) {
    const form = new FormData();
    form.set('category', String(categoryId));
    form.set('fileName', fileName);
    form.set('share', share ? 'yes' : 'no');
    form.set(
      'file',
      new Blob([buffer], { type: 'application/pdf' }),
      fileName
    );
    return this.request(`/employees/${employeeId}/files/`, {
      method: 'POST',
      body: form,
    });
  }
}

module.exports = { BambooClient };
