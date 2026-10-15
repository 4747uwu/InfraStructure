import { Cpu, Laptop } from 'lucide-react';

// A plain four-pane window, so the platform reads at a glance without a vendor logo.
function WindowsGlyph({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <rect x="1.5" y="1.5" width="6" height="6" rx="1.2" />
      <rect x="8.5" y="1.5" width="6" height="6" rx="1.2" />
      <rect x="1.5" y="8.5" width="6" height="6" rx="1.2" />
      <rect x="8.5" y="8.5" width="6" height="6" rx="1.2" />
    </svg>
  );
}

export const PLATFORMS = [
  { id: 'windows', label: 'Windows', long: 'Windows', icon: WindowsGlyph },
  { id: 'mac-arm', label: 'Apple silicon', long: 'Mac with Apple silicon', icon: Cpu },
  { id: 'mac-intel', label: 'Intel Mac', long: 'Mac with Intel', icon: Laptop },
];

export const platformById = (id) => PLATFORMS.find((p) => p.id === id) || PLATFORMS[0];

export function PlatformIcon({ id, size = 15 }) {
  const Icon = platformById(id).icon;
  return <Icon size={size} strokeWidth={2.1} />;
}

// Mirrors the server's guess, so the upload form opens on the right platform.
export function guessPlatform(fileName) {
  const name = fileName.toLowerCase();
  const isMac = /\.(dmg|pkg)$/.test(name) || /darwin|osx|macos|mac(?![a-z])/.test(name);
  if (!isMac) return 'windows';
  return /(x64|x86_64|amd64|intel)/.test(name) ? 'mac-intel' : 'mac-arm';
}
