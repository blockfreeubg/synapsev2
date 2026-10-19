import { store } from './store.js';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function headers(admin, extra = {}) {
  const h = { ...extra };
  const code = store.state.accessCode;
  if (code) h['x-access-code'] = code;
  if (admin) h.authorization = `Bearer ${store.state.adminToken}`;
  return h;
}

export async function api(path, { method = 'GET', body, admin = false, contentType } = {}) {
  const init = { method, headers: headers(admin) };
  if (body !== undefined) {
    if (body instanceof Blob || body instanceof ArrayBuffer) {
      init.body = body;
      init.headers['content-type'] = contentType || body.type || 'application/octet-stream';
    } else {
      init.body = JSON.stringify(body);
      init.headers['content-type'] = 'application/json';
    }
  }
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status})`);
  return data;
}

/** Upload a file with progress reporting (fetch has no upload progress). */
export function upload(path, file, { admin = true, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', path);
    for (const [k, v] of Object.entries(headers(admin, { 'content-type': file.type || 'application/vnd.android.package-archive' }))) {
      xhr.setRequestHeader(k, v);
    }
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* non-JSON error page */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(xhr.status, data.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new ApiError(0, 'Network error during upload'));
    xhr.send(file);
  });
}

export function wsUrl(path, params) {
  const url = new URL(path, location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
  if (store.state.accessCode) url.searchParams.set('code', store.state.accessCode);
  return url.toString();
}
