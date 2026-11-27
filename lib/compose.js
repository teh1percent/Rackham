import { SERVICES, byId } from './catalog.js';

// ---------- input validation ----------

const clean = (v) => (typeof v === 'string' ? v.trim() : '');
const noControl = (s) => !/[\u0000-\u001f\u007f]/.test(s);

function int(v, name, min, max) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number between ${min} and ${max}.`);
  return n;
}

function text(v, name, max = 200) {
  const s = clean(v);
  if (s.length > max || !noControl(s)) throw new Error(`${name} contains characters that can't be used.`);
  return s;
}

// Turns whatever the browser sent into a checked, complete config - or throws
// an Error whose message is safe to show to the user.
export function normalize(input = {}) {
  const wanted = Array.isArray(input.services) ? input.services : [];
  const services = SERVICES.map((s) => s.id).filter((id) => wanted.includes(id));
  if (!services.length) throw new Error('Pick at least one app.');
  const has = (id) => services.includes(id);

  for (const id of services) {
    const s = byId[id];
    for (const need of s.requires || []) {
      if (!has(need)) throw new Error(`${s.name} needs ${byId[need].name}. Add ${byId[need].name} or remove ${s.name}.`);
    }
    if (s.requiresAny && !s.requiresAny.some(has)) {
      throw new Error(`${s.name} needs ${s.requiresAny.map((n) => byId[n].name).join(' or ')}.`);
    }
  }

  const st = input.settings || {};
  const tz = clean(st.tz) || 'Etc/UTC';
  if (!/^[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(tz)) throw new Error('Timezone should look like "Europe/London".');
  const dataRoot = clean(st.dataRoot) || './data';
  if (!/^[A-Za-z0-9 _.\/\\:~-]+$/.test(dataRoot)) throw new Error('The data folder path contains characters that can\'t be used.');

  const config = {
    services,
    settings: { puid: int(st.puid ?? 1000, 'User ID', 0, 65535), pgid: int(st.pgid ?? 1000, 'Group ID', 0, 65535), tz, dataRoot },
    admin: null,
    usenet: null,
    indexers: [],
    plexClaim: '',
  };

  const a = input.admin || {};
  if (clean(a.username) || a.password) {
    const username = text(a.username, 'Admin username', 40);
    const password = typeof a.password === 'string' ? a.password : '';
    if (!/^[A-Za-z0-9_.-]{1,40}$/.test(username)) throw new Error('Admin username can use letters, numbers, dot, dash and underscore.');
    if (password.length < 8 || password.length > 100 || !noControl(password)) throw new Error('Admin password must be at least 8 characters.');
    if (password.includes('"') && password.includes("'")) throw new Error('Admin password can\'t contain both kinds of quote mark.');
    config.admin = { username, password };
  }

  const u = input.usenet || {};
  if (has('sabnzbd') && clean(u.host)) {
    const host = clean(u.host);
    if (!/^[A-Za-z0-9.-]{1,253}$/.test(host)) throw new Error('Usenet server should be a host name like "news.example.com".');
    const password = typeof u.password === 'string' ? u.password : '';
    if (!noControl(password) || (password.includes('"') && password.includes("'"))) throw new Error('Usenet password contains characters that can\'t be used.');
    config.usenet = {
      host,
      port: int(u.port ?? 563, 'Usenet port', 1, 65535),
      ssl: u.ssl !== false,
      username: text(u.username, 'Usenet username', 100),
      password,
      connections: int(u.connections ?? 20, 'Connections', 1, 100),
    };
  }

  if (has('prowlarr') && Array.isArray(input.indexers)) {
    for (const ix of input.indexers.slice(0, 20)) {
      const name = clean(ix.name), url = clean(ix.url), apiKey = clean(ix.apiKey);
      if (!name && !url && !apiKey) continue;
      if (!/^[\w .-]{1,40}$/.test(name)) throw new Error('Indexer names can use letters, numbers, spaces, dot and dash.');
      let parsed;
      try { parsed = new URL(url); } catch { throw new Error(`Indexer "${name}" needs a full address starting with https://`); }
      if (!/^https?:$/.test(parsed.protocol)) throw new Error(`Indexer "${name}" needs an http or https address.`);
      if (!/^[A-Za-z0-9_-]{4,128}$/.test(apiKey)) throw new Error(`Indexer "${name}" needs its API key.`);
      config.indexers.push({ name, url: url.replace(/\/+$/, ''), apiKey });
    }
  }

  if (has('plex') && clean(input.plexClaim)) {
    const claim = clean(input.plexClaim);
    if (!/^claim-[A-Za-z0-9_-]{6,64}$/.test(claim)) throw new Error('A Plex claim token starts with "claim-".');
    config.plexClaim = claim;
  }

  return config;
}

// ---------- YAML ----------

function scalar(v) {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  const risky = s === '' || /^\s|\s$/.test(s) || /[:#{}\[\],&*!|>'"%@`\\]/.test(s) || /^(true|false|null|yes|no|on|off|~)$/i.test(s) || /^[\d.+-]/.test(s);
  return risky ? JSON.stringify(s) : s;
}

export function toYaml(value, indent = 0) {
  const pad = '  '.repeat(indent);
  if (Array.isArray(value)) return value.map((v) => `${pad}- ${scalar(v)}\n`).join('');
  let out = '';
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'object' && !Object.keys(v).length) continue;
    if (typeof v === 'object') out += `${pad}${k}:\n${toYaml(v, indent + 1)}`;
    else out += `${pad}${k}: ${scalar(v)}\n`;
  }
  return out;
}

// ---------- generators ----------

const HEADER = `# Generated by Rackham. Settings live in the .env file next to this one.
#
# Folder layout under DATA_ROOT - one shared mount, so finished downloads are
# moved into the library instantly instead of being copied:
#
#   usenet/incomplete   downloads in progress
#   usenet/complete     finished downloads
#   media/movies        Radarr's library
#   media/tv            Sonarr's library

`;

export function buildCompose(config) {
  const services = {};
  const volumes = [];
  const entry = (name, s) => ({
    image: s.image,
    container_name: name,
    init: s.init,
    restart: 'unless-stopped',
    // On SELinux hosts, containers can't read host folders unless labelling is
    // off for them. Relabelling (":z") isn't an option: NAS pools such as
    // mergerfs and ZFS often can't store labels at all.
    security_opt: config.selinux && s.volumes.some((v) => /^[.$\/]/.test(v)) ? ['label=disable'] : undefined,
    shm_size: s.shm_size,
    ulimits: s.ulimits,
    command: s.command,
    networks: ['media'],
    environment: s.environment,
    ports: s.port ? [`${s.port}:${s.port}`] : undefined,
    volumes: s.volumes,
    // A list names other picked apps; a map (with conditions) names the app's own sidecars.
    depends_on: Array.isArray(s.depends_on) ? s.depends_on.filter((d) => config.services.includes(d)) : s.depends_on,
    healthcheck: s.healthcheck,
  });
  for (const id of config.services) {
    const s = byId[id];
    services[id] = entry(id, s);
    for (const [name, side] of Object.entries(s.sidecars || {})) services[name] = entry(name, side);
    volumes.push(...(s.namedVolumes || []));
  }
  let yaml = HEADER + toYaml({ name: 'media', services, networks: { media: { name: 'media' } } });
  if (volumes.length) yaml += `volumes:\n${volumes.map((v) => `  ${v}: {}\n`).join('')}`;
  return yaml;
}

const envValue = (v) => (/\s/.test(String(v)) ? `'${v}'` : String(v));

// `keys` is { sonarr, radarr, prowlarr } - only the selected ones are written.
export function buildEnv(config, keys = {}) {
  const lines = [
    '# User and group the apps run as (run `id` on the server to find yours)',
    `PUID=${config.settings.puid}`,
    `PGID=${config.settings.pgid}`,
    `TZ=${config.settings.tz}`,
    '',
    '# Root of downloads and the media library',
    `DATA_ROOT=${envValue(config.settings.dataRoot)}`,
  ];
  if (config.services.includes('plex')) {
    lines.push('', '# Only used the first time Plex starts (https://plex.tv/claim)', `PLEX_CLAIM=${config.plexClaim}`);
  }
  const keyed = ['sonarr', 'radarr', 'prowlarr'].filter((id) => config.services.includes(id));
  if (keyed.length) {
    lines.push('', '# API keys the apps use to talk to each other - keep these private');
    for (const id of keyed) lines.push(`${id.toUpperCase()}_API_KEY=${keys[id] || ''}`);
  }
  if (config.services.includes('tracearr')) {
    const t = keys.tracearr || {};
    lines.push(
      '', '# Tracearr secrets - changing these after the first start breaks its database login',
      `TRACEARR_DB_PASSWORD=${t.db || ''}`, `TRACEARR_JWT_SECRET=${t.jwt || ''}`, `TRACEARR_COOKIE_SECRET=${t.cookie || ''}`,
    );
  }
  return lines.join('\n') + '\n';
}
