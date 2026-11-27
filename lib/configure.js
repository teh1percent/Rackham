// Talks to each running app's API to wire the stack together.
// Every function is safe to run twice: it checks what exists before adding.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(url, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`${method} ${new URL(url).pathname} answered ${res.status}: ${raw.slice(0, 200)}`);
  try { return raw ? JSON.parse(raw) : null; } catch { return raw; }
}

// Polls until the app answers, or gives up after `minutes`.
// `strict` waits for a success answer rather than any answer below 500.
export async function waitFor(url, minutes = 5, strict = false) {
  const deadline = Date.now() + minutes * 60000;
  let last = 'no answer';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (strict ? res.ok : res.status < 500) return;
      last = `status ${res.status}`;
    } catch (e) { last = e.cause?.code || e.message; }
    await sleep(3000);
  }
  throw new Error(`Didn't start within ${minutes} minutes (${last}). Check its logs with "docker logs".`);
}

const setFields = (item, values) => {
  for (const f of item.fields || []) if (f.name in values) f.value = values[f.name];
  return item;
};

// ---------- Sonarr / Radarr / Prowlarr ----------

function arrClient(base, key, version) {
  return (path, method, body) => http(`${base}/api/${version}${path}`, { method, body, headers: { 'X-Api-Key': key } });
}

async function setArrLogin(api, admin) {
  if (!admin) return 'no login set';
  const host = await api('/config/host');
  await api(`/config/host/${host.id}`, 'PUT', {
    ...host,
    authenticationMethod: 'forms',
    authenticationRequired: 'enabled',
    username: admin.username,
    password: admin.password,
    passwordConfirmation: admin.password,
  });
  return `login "${admin.username}"`;
}

// kind: 'sonarr' | 'radarr'
export async function configureArr(kind, { base, key, sabKey, admin }) {
  const api = arrClient(base, key, 'v3');
  const done = [];
  const folder = kind === 'sonarr' ? '/data/media/tv' : '/data/media/movies';

  const roots = await api('/rootfolder');
  if (!roots.some((r) => r.path.replace(/\/$/, '') === folder)) await api('/rootfolder', 'POST', { path: folder });
  done.push(`library folder ${folder}`);

  if (sabKey) {
    const clients = await api('/downloadclient');
    if (!clients.some((c) => c.implementation === 'Sabnzbd')) {
      const schema = (await api('/downloadclient/schema')).find((s) => s.implementation === 'Sabnzbd');
      if (!schema) throw new Error('This version has no SABnzbd download client option.');
      setFields(schema, {
        host: 'sabnzbd', port: 8080, useSsl: false, apiKey: sabKey,
        tvCategory: 'tv', movieCategory: 'movies',
      });
      await api('/downloadclient', 'POST', { ...schema, name: 'SABnzbd', enable: true });
    }
    done.push('SABnzbd connected');
  }

  done.push(await setArrLogin(api, admin));
  return done.join(', ');
}

export async function configureProwlarr({ base, key, apps, indexers, admin }) {
  const api = arrClient(base, key, 'v1');
  const done = [];

  const existingApps = await api('/applications');
  const appSchemas = apps.length ? await api('/applications/schema') : [];
  for (const app of apps) {
    const impl = app.id === 'sonarr' ? 'Sonarr' : 'Radarr';
    if (!existingApps.some((a) => a.implementation === impl)) {
      const schema = appSchemas.find((s) => s.implementation === impl);
      if (!schema) throw new Error(`This version of Prowlarr has no ${impl} option.`);
      setFields(schema, { prowlarrUrl: 'http://prowlarr:9696', baseUrl: `http://${app.id}:${app.port}`, apiKey: app.key });
      await api('/applications', 'POST', { ...schema, name: impl, syncLevel: 'fullSync' });
    }
    done.push(`${impl} linked`);
  }

  if (indexers.length) {
    const existing = await api('/indexer');
    const generic = (await api('/indexer/schema')).find((s) => s.implementation === 'Newznab' && /generic/i.test(s.name));
    if (!generic) throw new Error('This version of Prowlarr has no generic Newznab indexer option.');
    for (const ix of indexers) {
      if (existing.some((e) => e.name === ix.name)) continue;
      const item = setFields(structuredClone(generic), { baseUrl: ix.url, apiKey: ix.apiKey });
      await api('/indexer', 'POST', { ...item, name: ix.name, enable: true, appProfileId: 1, priority: 25 });
    }
    done.push(`${indexers.length} indexer${indexers.length > 1 ? 's' : ''} added`);
  }

  done.push(await setArrLogin(api, admin));
  return done.join(', ');
}

// ---------- SABnzbd ----------

// Everything was written to sabnzbd.ini before start; this confirms it took.
export async function checkSab({ base, key, hasServer }) {
  const res = await http(`${base}/api?mode=get_config&section=misc&output=json&apikey=${key}`);
  if (!res?.config) throw new Error('SABnzbd did not accept the API key written to its settings file.');
  return hasServer ? 'folders, categories and usenet server set' : 'folders and categories set - add a usenet server in SABnzbd';
}

// ---------- Jellyfin ----------

const jfAuth = (token) => `MediaBrowser Client="Rackham", Device="setup", DeviceId="rackham-setup", Version="1.0"${token ? `, Token="${token}"` : ''}`;

// Returns { detail, apiKey }. `options` is { serverName, language, country }.
export async function configureJellyfin({ base, admin, options = {} }) {
  const language = options.language || 'en';
  const country = options.country || 'US';
  const info = await http(`${base}/System/Info/Public`);
  if (!info.StartupWizardCompleted) {
    // Jellyfin answers "still loading" (503) on its setup endpoints for a while after it starts.
    await waitFor(`${base}/Startup/Configuration`, 5, true);
    await http(`${base}/Startup/Configuration`, { method: 'POST', body: { UICulture: 'en-US', MetadataCountryCode: country, PreferredMetadataLanguage: language } });
    await http(`${base}/Startup/User`); // creates the first user so it can be renamed
    await http(`${base}/Startup/User`, { method: 'POST', body: { Name: admin.username, Password: admin.password } });
    await http(`${base}/Startup/RemoteAccess`, { method: 'POST', body: { EnableRemoteAccess: true, EnableAutomaticPortMapping: false } });
    await http(`${base}/Startup/Complete`, { method: 'POST' });
  }

  const login = await http(`${base}/Users/AuthenticateByName`, {
    method: 'POST', headers: { Authorization: jfAuth() }, body: { Username: admin.username, Pw: admin.password },
  });
  const headers = { Authorization: jfAuth(login.AccessToken) };
  const existing = await http(`${base}/Library/VirtualFolders`, { headers });
  const wanted = [['Movies', 'movies', '/data/media/movies'], ['Shows', 'tvshows', '/data/media/tv']];
  for (const [name, type, path] of wanted) {
    if (existing.some((f) => (f.Locations || []).includes(path))) continue;
    const q = new URLSearchParams({ name, collectionType: type, paths: path, refreshLibrary: 'false' });
    await http(`${base}/Library/VirtualFolders?${q}`, { method: 'POST', headers, body: { LibraryOptions: { PathInfos: [{ Path: path }], PreferredMetadataLanguage: language, MetadataCountryCode: country } } });
  }
  const done = [`login "${admin.username}"`, 'Movies and Shows libraries'];

  // Server-wide settings: applied on every run, so they can be changed later.
  const system = await http(`${base}/System/Configuration`, { headers });
  const settings = { PreferredMetadataLanguage: language, MetadataCountryCode: country, ...(options.serverName ? { ServerName: options.serverName } : {}) };
  if (Object.entries(settings).some(([k, v]) => system[k] !== v)) {
    await http(`${base}/System/Configuration`, { method: 'POST', headers, body: { ...system, ...settings } });
  }
  if (options.serverName) done.push(`named "${options.serverName}"`);

  // One API key that the other apps (Wizarr, for example) can be given.
  const findKey = async () => (await http(`${base}/Auth/Keys`, { headers })).Items?.find((k) => k.AppName === 'Rackham')?.AccessToken;
  let apiKey = await findKey();
  if (!apiKey) {
    await http(`${base}/Auth/Keys?app=Rackham`, { method: 'POST', headers });
    apiKey = await findKey();
  }
  if (apiKey) done.push('API key ready');
  return { detail: done.join(', '), apiKey };
}

// ---------- Plex ----------

export async function configurePlex({ base, token }) {
  const headers = { 'X-Plex-Token': token };
  const sections = await http(`${base}/library/sections`, { headers });
  const have = (sections?.MediaContainer?.Directory || []).flatMap((d) => (d.Location || []).map((l) => l.path));
  const wanted = [
    { name: 'Movies', type: 'movie', agent: 'tv.plex.agents.movie', scanner: 'Plex Movie', location: '/data/media/movies' },
    { name: 'TV Shows', type: 'show', agent: 'tv.plex.agents.series', scanner: 'Plex TV Series', location: '/data/media/tv' },
  ];
  for (const lib of wanted) {
    if (have.includes(lib.location)) continue;
    const q = new URLSearchParams({ ...lib, language: 'en-US' });
    await http(`${base}/library/sections?${q}`, { method: 'POST', headers });
  }
  return 'Movies and TV Shows libraries';
}
