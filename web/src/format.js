export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
const STEPS = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

export function timeAgo(value) {
  if (!value) return '';
  const seconds = (new Date(value).getTime() - Date.now()) / 1000;
  if (Math.abs(seconds) < 45) return 'just now';
  for (const [unit, size] of STEPS) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  }
  return relative.format(Math.round(seconds / 60), 'minute');
}

export function formatDate(value) {
  if (!value) return '';
  return new Date(value).toLocaleString('en', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// "Ganesham Teleradiology Setup 0.1.2.exe" -> "0.1.2"
export function guessVersion(fileName) {
  const stem = fileName.replace(/\.[a-z0-9]+$/i, '');
  return /\d+(?:\.\d+){1,3}/.exec(stem)?.[0] || '';
}

export function fileKind(fileName) {
  const ext = fileName.toLowerCase().split('.').pop();
  return (
    { exe: 'Windows installer', msi: 'Windows installer', zip: 'ZIP archive', '7z': '7-Zip archive', dmg: 'macOS disk image', pkg: 'macOS package' }[ext] ||
    'File'
  );
}

export function initials(name) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

// Ten clearly different hues, so neighbouring clients rarely look alike.
const GRADIENTS = [
  ['#5ac8fa', '#0a6cff'], // blue
  ['#8e8bff', '#4b3fd8'], // indigo
  ['#d98cff', '#9b40d8'], // purple
  ['#ff7eb6', '#e0337a'], // pink
  ['#ff8a7a', '#e5322d'], // red
  ['#ffb340', '#ff6a00'], // orange
  ['#ffe066', '#f0a800'], // yellow
  ['#5be27a', '#1f9e45'], // green
  ['#5ce0d6', '#0a96a6'], // teal
  ['#a7b0c0', '#4b5563'], // graphite
];

// Same client, same colour, every time - without storing anything.
export function gradientFor(name) {
  let hash = 0;
  for (const ch of name.toLowerCase()) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return GRADIENTS[hash % GRADIENTS.length];
}

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
