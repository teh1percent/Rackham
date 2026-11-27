// Writes app settings to disk before the containers start for the first time,
// so every app comes up with a known API key and the right folders.
// Existing config files are never overwritten - their keys are read back instead.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const newKey = () => crypto.randomBytes(16).toString('hex');
const newSecret = () => crypto.randomBytes(32).toString('hex');

// Tracearr's secrets live only in .env. They are reused if already there,
// because its database is created with the first password it sees.
export function tracearrSecrets(envFile) {
  let old = '';
  try { old = fs.readFileSync(envFile, 'utf8'); } catch { /* first run */ }
  const get = (name) => old.match(new RegExp(`^${name}=([A-Za-z0-9]+)$`, 'm'))?.[1];
  return {
    db: get('TRACEARR_DB_PASSWORD') || newKey(),
    jwt: get('TRACEARR_JWT_SECRET') || newSecret(),
    cookie: get('TRACEARR_COOKIE_SECRET') || newSecret(),
  };
}

function chown(target, uid, gid) {
  if (process.platform === 'win32') return;
  try { fs.chownSync(target, uid, gid); } catch { /* not root - the container fixes ownership of /config itself */ }
}

function ensureDir(dir, uid, gid) {
  fs.mkdirSync(dir, { recursive: true });
  chown(dir, uid, gid);
}

// Sonarr, Radarr and Prowlarr all read <ApiKey> from /config/config.xml.
export function seedArr(configDir, uid, gid) {
  ensureDir(configDir, uid, gid);
  const file = path.join(configDir, 'config.xml');
  if (fs.existsSync(file)) {
    const found = fs.readFileSync(file, 'utf8').match(/<ApiKey>([A-Za-z0-9]+)<\/ApiKey>/);
    if (found) return { key: found[1], existing: true };
    throw new Error(`${file} exists but has no API key in it. Move it aside and try again.`);
  }
  const key = newKey();
  fs.writeFileSync(file, `<Config>\n  <ApiKey>${key}</ApiKey>\n</Config>\n`, { mode: 0o600 });
  chown(file, uid, gid);
  return { key, existing: false };
}

const ini = (v) => {
  const s = String(v);
  if (/^[A-Za-z0-9_.@\/-]*$/.test(s)) return s;
  return s.includes('"') ? `'${s}'` : `"${s}"`;
};

export function buildSabIni({ apiKey, nzbKey, admin, usenet }) {
  const lines = [
    '__version__ = 19',
    '__encoding__ = utf-8',
    '[misc]',
    `api_key = ${apiKey}`,
    `nzb_key = ${nzbKey}`,
    'download_dir = /data/usenet/incomplete',
    'complete_dir = /data/usenet/complete',
    // Lets Sonarr and Radarr reach SABnzbd by its container name.
    'host_whitelist = sabnzbd,',
    'permissions = 775',
  ];
  if (admin) lines.push(`username = ${ini(admin.username)}`, `password = ${ini(admin.password)}`);
  if (usenet) {
    lines.push(
      '[servers]',
      `[[${usenet.host}]]`,
      `name = ${usenet.host}`,
      `displayname = ${usenet.host}`,
      `host = ${usenet.host}`,
      `port = ${usenet.port}`,
      'timeout = 60',
      `username = ${ini(usenet.username)}`,
      `password = ${ini(usenet.password)}`,
      `connections = ${usenet.connections}`,
      `ssl = ${usenet.ssl ? 1 : 0}`,
      'ssl_verify = 2',
      'enable = 1',
      'required = 0',
      'optional = 0',
      'retention = 0',
      'priority = 0',
    );
  }
  lines.push('[categories]');
  const cats = [['*', 3, ''], ['movies', '""', 'movies'], ['tv', '""', 'tv']];
  cats.forEach(([name, pp, dir], order) => {
    lines.push(`[[${name}]]`, `name = ${name}`, `order = ${order}`, `pp = ${pp}`, `script = ${name === '*' ? 'None' : 'Default'}`, `dir = ${dir || '""'}`, 'newzbin = ""', `priority = ${name === '*' ? 0 : -100}`);
  });
  return lines.join('\n') + '\n';
}

export function seedSab(configDir, uid, gid, { admin, usenet }) {
  ensureDir(configDir, uid, gid);
  const file = path.join(configDir, 'sabnzbd.ini');
  if (fs.existsSync(file)) {
    const found = fs.readFileSync(file, 'utf8').match(/^api_key\s*=\s*([A-Za-z0-9]+)/m);
    if (found) return { key: found[1], existing: true };
    throw new Error(`${file} exists but has no API key in it. Move it aside and try again.`);
  }
  const key = newKey();
  fs.writeFileSync(file, buildSabIni({ apiKey: key, nzbKey: newKey(), admin, usenet }), { mode: 0o600 });
  chown(file, uid, gid);
  return { key, existing: false };
}

// Seerr runs as user 1000 regardless of PUID.
export function seedSeerr(configDir) {
  ensureDir(configDir, 1000, 1000);
}

export function readPlexToken(plexConfigDir) {
  const file = path.join(plexConfigDir, 'Library', 'Application Support', 'Plex Media Server', 'Preferences.xml');
  try {
    return fs.readFileSync(file, 'utf8').match(/PlexOnlineToken="([^"]+)"/)?.[1] || null;
  } catch { return null; }
}
