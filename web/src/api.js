export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check your connection and try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // A session that expired mid-use sends the whole app back to sign-in.
    if (res.status === 401 && !path.startsWith('/auth/') && !path.startsWith('/public/')) {
      window.dispatchEvent(new Event('rh:signed-out'));
    }
    throw new ApiError(res.status, data.error || `Request failed (${res.status}).`);
  }
  return data;
}

// The file goes up as the raw request body so the browser can report real progress.
export function uploadRelease({ client, version, notes, platform, file, onProgress }) {
  const xhr = new XMLHttpRequest();
  const promise = new Promise((resolve, reject) => {
    const query = new URLSearchParams({ client, version, notes: notes || '', platform, filename: file.name });
    xhr.open('PUT', `/api/upload?${query}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded, e.total);
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(xhr.status, data.error || `Upload failed (${xhr.status}).`));
    };
    xhr.onerror = () => reject(new ApiError(0, 'The upload was interrupted. Check your connection and try again.'));
    xhr.onabort = () => reject(new ApiError(-1, 'Upload cancelled.'));
    xhr.send(file);
  });
  return { promise, cancel: () => xhr.abort() };
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // The async clipboard API needs HTTPS or localhost. Over plain http://server-ip it is
    // unavailable, so fall back to the selection-based copy.
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {}
    area.remove();
    return ok;
  }
}
