import { newToken } from './security.js';

export const PLATFORMS = ['windows', 'mac-arm', 'mac-intel'];

// Where each platform's "current version" and always-latest link tokens live on a client.
// Windows keeps the original top-level fields, so links shared before platforms existed
// keep working unchanged as the Windows links.
const FIELDS = {
  windows: { current: 'currentReleaseId', direct: 'directToken', protected: 'protectedToken' },
  'mac-arm': { current: 'macArm.currentReleaseId', direct: 'macArm.directToken', protected: 'macArm.protectedToken' },
  'mac-intel': { current: 'macIntel.currentReleaseId', direct: 'macIntel.directToken', protected: 'macIntel.protectedToken' },
};

export const field = (platform, key) => FIELDS[platform][key];

export function read(doc, platform, key) {
  return field(platform, key)
    .split('.')
    .reduce((value, part) => value?.[part], doc) ?? null;
}

export const normalizePlatform = (value) => (PLATFORMS.includes(value) ? value : null);

// Releases stored before platforms existed were all Windows installers.
export const platformOf = (release) => release.platform || 'windows';

// Fresh link tokens for the Mac platforms, for new clients and for clients created before platforms existed.
export const macLinkFields = () => ({
  macArm: { currentReleaseId: null, directToken: newToken(), protectedToken: newToken() },
  macIntel: { currentReleaseId: null, directToken: newToken(), protectedToken: newToken() },
});

// Best guess from the file name, used when an upload does not say which platform it is for.
export function guessPlatform(fileName) {
  const name = String(fileName).toLowerCase();
  // "mac" must end a word ("ACHUMAC.zip", "setup-mac.zip") so names like "Pharmacy" stay Windows.
  const isMac = /\.(dmg|pkg)$/.test(name) || /darwin|osx|macos|mac(?![a-z])/.test(name);
  if (!isMac) return 'windows';
  return /(x64|x86_64|amd64|intel)/.test(name) ? 'mac-intel' : 'mac-arm';
}
