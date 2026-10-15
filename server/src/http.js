import { config } from './config.js';

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export function baseUrl(req) {
  return config.publicBaseUrl || `${req.protocol}://${req.get('host')}`;
}

export function cleanText(value, max) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max);
}

export function slugify(name) {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// Keeps the name people will see when they download, minus anything a filesystem rejects.
export function safeFileName(name) {
  const base = String(name ?? '').split(/[\\/]/).pop();
  return base
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, 180);
}

// Standalone page for download links that cannot be served. It is shown to people
// outside the app, so it carries its own styles instead of depending on the SPA.
export function messagePage(title, body) {
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; --bg:#f5f5f7; --fg:#1d1d1f; --muted:#6e6e73; }
  @media (prefers-color-scheme: dark) { :root { --bg:#000; --fg:#f5f5f7; --muted:#a1a1a6; } }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--fg);
         font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI Variable Display","Segoe UI",system-ui,sans-serif; }
  main { max-width:420px; padding:32px; text-align:center; }
  h1 { font-size:28px; font-weight:600; letter-spacing:-0.02em; margin:0 0 10px; }
  p { font-size:16px; line-height:1.5; color:var(--muted); margin:0; }
</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(body)}</p></main></body></html>`;
}
