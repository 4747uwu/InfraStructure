import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const envFile = join(root, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const env = process.env;

export const config = {
  root,
  port: Number(env.PORT || 4600),
  mongoUri: env.MONGO_URI || 'mongodb://127.0.0.1:27017',
  dbName: env.MONGO_DB || 'routerhub',
  storageDir: resolve(root, env.STORAGE_DIR || 'storage'),
  webDir: join(root, 'web', 'dist'),
  // Origin used when building shareable links. Empty = whatever host the request came in on.
  publicBaseUrl: (env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
  maxUploadBytes: Number(env.MAX_UPLOAD_MB || 2048) * 1024 * 1024,
  secureCookies: env.SECURE_COOKIES === 'true',
  trustProxy: env.TRUST_PROXY || '',
  // Only read on first boot, to create the two accounts. A *_PASSWORD_HASH wins over a
  // plain *_PASSWORD, so a deployment can ship without the password itself.
  seed: {
    master: {
      username: env.MASTER_USERNAME || 'master',
      password: env.MASTER_PASSWORD || '',
      passwordHash: env.MASTER_PASSWORD_HASH || '',
    },
    helper: {
      username: env.HELPER_USERNAME || 'helper',
      password: env.HELPER_PASSWORD || '',
      passwordHash: env.HELPER_PASSWORD_HASH || '',
    },
  },
};

export const ALLOWED_EXTENSIONS = ['.exe', '.msi', '.zip', '.7z', '.dmg', '.pkg'];
export const SESSION_COOKIE = 'rh_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const DOWNLOAD_TICKET_TTL_S = 15 * 60;
