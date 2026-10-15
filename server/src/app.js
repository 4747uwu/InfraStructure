import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { loadAuth } from './auth.js';
import { config } from './config.js';
import { ping } from './db.js';
import { HttpError, messagePage } from './http.js';
import authRoutes from './routes/auth.js';
import clientRoutes from './routes/clients.js';
import { downloads, publicApi } from './routes/public.js';
import releaseRoutes from './routes/releases.js';
import settingsRoutes from './routes/settings.js';

// Sessions ride on a cookie, so refuse state-changing calls that a page on another origin started.
function sameOrigin(req, _res, next) {
  const origin = req.get('origin');
  if (!origin || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  let host = '';
  try {
    host = new URL(origin).host;
  } catch {}
  const allowed = [req.get('host')];
  if (config.publicBaseUrl) allowed.push(new URL(config.publicBaseUrl).host);
  next(allowed.includes(host) ? undefined : new HttpError(403, 'Cross-site request blocked.'));
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) {
    app.set('trust proxy', Number.isNaN(Number(config.trustProxy)) ? config.trustProxy : Number(config.trustProxy));
  }

  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      // Link tokens live in URLs; never hand them to other sites in a Referer header.
      'Referrer-Policy': 'no-referrer',
    });
    next();
  });

  const api = express.Router();
  api.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  // Used by the container health check and the deploy pipeline: healthy means the database answers too.
  api.get('/health', async (_req, res) => {
    await ping();
    res.json({ ok: true });
  });
  api.use(sameOrigin, express.json({ limit: '100kb' }), loadAuth);
  api.use(authRoutes, publicApi, clientRoutes, releaseRoutes, settingsRoutes);
  api.use((_req, _res, next) => next(new HttpError(404, 'Not found.')));
  api.use((err, _req, res, _next) => {
    if (res.headersSent) return res.destroy();
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request was not valid JSON.' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server.' });
  });
  app.use('/api', api);

  app.use(downloads);

  const indexHtml = join(config.webDir, 'index.html');
  app.use(express.static(config.webDir, { index: false, maxAge: '1h' }));
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (!existsSync(indexHtml)) {
      return res
        .status(503)
        .type('html')
        .send(messagePage('Interface not built yet', 'Run "npm run build" in the project folder, then reload.'));
    }
    res.sendFile(indexHtml);
  });

  app.use((err, _req, res, _next) => {
    console.error(err);
    if (res.headersSent) return res.destroy();
    res.status(500).type('html').send(messagePage('Something went wrong', 'Please try again in a moment.'));
  });

  return app;
}
