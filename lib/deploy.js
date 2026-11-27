// The deploy job: write files, start containers, then configure each app.
// Progress is kept in memory as a list of steps the browser polls.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { byId } from './catalog.js';
import { buildCompose, buildEnv } from './compose.js';
import { seedArr, seedSab, seedSeerr, readPlexToken, tracearrSecrets } from './seed.js';
import { waitFor, configureArr, configureProwlarr, checkSab, configureJellyfin, configurePlex } from './configure.js';

export const inContainer = fs.existsSync('/.dockerenv');

// Runs a command without a shell; resolves with its combined output.
export function run(cmd, args, { cwd, onLine } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try { child = spawn(cmd, args, { cwd, windowsHide: true }); } catch (e) { return resolve({ code: -1, out: e.message }); }
    const take = (chunk) => {
      out += chunk;
      const line = String(chunk).trim().split(/\r?\n/).pop();
      if (line && onLine) onLine(line);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (e) => resolve({ code: -1, out: e.message }));
    child.on('close', (code) => resolve({ code, out }));
  });
}

// { available, selinux } - selinux is true when the Docker host enforces it for containers.
export async function dockerInfo() {
  const a = await run('docker', ['info', '--format', '{{json .SecurityOptions}}']);
  if (a.code !== 0) return { available: false, selinux: false };
  const compose = await run('docker', ['compose', 'version']);
  return { available: compose.code === 0, selinux: /name=selinux/.test(a.out) };
}

// Things the wizard can't finish because they need the user's own sign-in.
export function manualSteps(config) {
  const has = (id) => config.services.includes(id);
  const out = [];
  if (has('plex') && !config.plexClaim) {
    out.push({ service: 'plex', path: '/web', title: 'Sign in to Plex and claim the server', notes: ['Add libraries pointing at /data/media/movies and /data/media/tv.'] });
  }
  if (has('jellyfin') && !config.admin) {
    out.push({ service: 'jellyfin', path: '', title: 'Finish Jellyfin\'s first-run screens', notes: ['Add libraries pointing at /data/media/movies and /data/media/tv.'] });
  }
  if (has('sabnzbd') && !config.usenet) {
    out.push({ service: 'sabnzbd', path: '', title: 'Add your usenet server in SABnzbd', notes: ['Folders and categories are already set.'] });
  }
  if (has('prowlarr') && !config.indexers.length) {
    out.push({ service: 'prowlarr', path: '', title: 'Add your indexers in Prowlarr', notes: ['They sync to Sonarr and Radarr automatically.'] });
  }
  if (has('tautulli')) {
    out.push({ service: 'tautulli', path: '', title: 'Connect Tautulli to Plex', notes: ['Sign in with your Plex account.', 'Plex address: plex, port 32400.'] });
  }
  if (has('tracearr')) {
    const notes = ['Create your Tracearr account, then add your servers.'];
    if (has('plex')) notes.push('Plex address: http://plex:32400');
    if (has('jellyfin')) notes.push('Jellyfin address: http://jellyfin:8096');
    out.push({ service: 'tracearr', path: '', title: 'Connect Tracearr to your media servers', notes });
  }
  if (has('seerr')) {
    const notes = ['Sign in with your Plex or Jellyfin account.'];
    if (has('jellyfin')) notes.push('Jellyfin address: jellyfin, port 8096.');
    if (has('radarr')) notes.push('Radarr: host radarr, port 7878, API key {radarr}.');
    if (has('sonarr')) notes.push('Sonarr: host sonarr, port 8989, API key {sonarr}.');
    out.push({ service: 'seerr', path: '', title: 'Set up Seerr', notes });
  }
  if (has('wizarr')) {
    const notes = ['Create the Wizarr admin account.'];
    if (has('plex')) notes.push('Plex address: http://plex:32400');
    if (has('jellyfin')) notes.push('Jellyfin address: http://jellyfin:8096');
    out.push({ service: 'wizarr', path: '', title: 'Set up Wizarr', notes });
  }
  return out;
}

export function planSteps(config) {
  const steps = [
    { id: 'files', label: 'Write the compose file and settings' },
    { id: 'folders', label: 'Create download and library folders' },
    { id: 'up', label: 'Download and start the apps' },
  ];
  for (const id of config.services) steps.push({ id, service: id, label: `Set up ${byId[id].name}` });
  return steps.map((s) => ({ ...s, status: 'pending', detail: '' }));
}

export function createJob(config, stackDir) {
  const job = { running: true, failed: false, steps: planSteps(config), manual: manualSteps(config), keys: {} };
  const step = (id) => job.steps.find((s) => s.id === id);

  async function stage(id, fn) {
    const s = step(id);
    s.status = 'running';
    try {
      const result = await fn(s);
      if (result?.manual) { s.status = 'manual'; s.detail = result.manual; } else { s.status = 'done'; s.detail = result || ''; }
      return true;
    } catch (e) {
      s.status = 'failed';
      s.detail = e.message;
      job.failed = true;
      return false;
    }
  }

  const has = (id) => config.services.includes(id);
  // Inside a container we reach apps by name on the shared network; otherwise via published ports.
  const base = (id) => (inContainer ? `http://${id}:${byId[id].port}` : `http://localhost:${byId[id].port}`);
  const cfg = (id) => path.join(stackDir, 'config', id);
  const { puid, pgid } = config.settings;

  job.promise = (async () => {
    const ok = await stage('files', async () => {
      fs.mkdirSync(path.join(stackDir, 'config'), { recursive: true });
      const kept = [];
      for (const id of ['sonarr', 'radarr', 'prowlarr'].filter(has)) {
        const r = seedArr(cfg(id), puid, pgid);
        job.keys[id] = r.key;
        if (r.existing) kept.push(byId[id].name);
      }
      if (has('sabnzbd')) {
        const r = seedSab(cfg('sabnzbd'), puid, pgid, config);
        job.keys.sabnzbd = r.key;
        if (r.existing) kept.push('SABnzbd');
      }
      if (has('seerr')) seedSeerr(cfg('seerr'));
      if (has('tracearr')) job.keys.tracearr = tracearrSecrets(path.join(stackDir, '.env'));
      fs.writeFileSync(path.join(stackDir, 'docker-compose.yml'), buildCompose(config));
      fs.writeFileSync(path.join(stackDir, '.env'), buildEnv(config, job.keys), { mode: 0o600 });
      return kept.length ? `Kept existing settings for ${kept.join(', ')}` : `Saved in ${stackDir}`;
    })
    && await stage('folders', async () => {
      const dataRoot = path.resolve(stackDir, config.settings.dataRoot);
      const dirs = ['/data/usenet/incomplete', '/data/usenet/complete', '/data/media/movies', '/data/media/tv'];
      const script = `mkdir -p ${dirs.join(' ')} && chown ${puid}:${pgid} /data /data/usenet /data/media ${dirs.join(' ')}`;
      const label = config.selinux ? ['--security-opt', 'label=disable'] : [];
      const r = await run('docker', ['run', '--rm', ...label, '-v', `${dataRoot}:/data`, 'alpine:3', 'sh', '-c', script]);
      if (r.code !== 0) throw new Error(`Couldn't create folders in ${dataRoot}: ${r.out.trim().slice(-300)}`);
      return dataRoot;
    })
    && await stage('up', async (s) => {
      // Image registries throttle and drop connections now and then; pulls resume where they stopped.
      let r;
      for (let attempt = 1; attempt <= 4; attempt++) {
        r = await run('docker', ['compose', 'up', '-d', '--remove-orphans'], { cwd: stackDir, onLine: (l) => { s.detail = l.slice(0, 160); } });
        if (r.code === 0 || !/registry|retry-after|toomanyrequests|timeout|connection reset|TLS handshake|EOF/i.test(r.out)) break;
        s.detail = `Download interrupted, trying again (${attempt} of 3)`;
        await new Promise((res) => setTimeout(res, 15000));
      }
      if (r.code !== 0) throw new Error(r.out.trim().split(/\r?\n/).slice(-4).join(' ').slice(-400));
      if (inContainer) {
        const c = await run('docker', ['network', 'connect', 'media', os.hostname()]);
        if (c.code !== 0 && !/already exists/i.test(c.out)) throw new Error(`Apps started, but setup couldn't join their network: ${c.out.trim().slice(-200)}`);
      }
      return `${config.services.length} apps running`;
    });

    if (ok) await Promise.all(config.services.map((id) => stage(id, () => setUp(id))));
    else for (const s of job.steps) if (s.status === 'pending') s.status = 'skipped';
    job.running = false;
  })();

  async function setUp(id) {
    const probes = {
      sonarr: '/ping', radarr: '/ping', prowlarr: '/ping', sabnzbd: '/api?mode=version',
      jellyfin: '/System/Info/Public', plex: '/identity', tautulli: '/', tracearr: '/health', seerr: '/api/v1/status', wizarr: '/',
    };
    await waitFor(base(id) + probes[id]);

    if (id === 'sonarr' || id === 'radarr') {
      return configureArr(id, { base: base(id), key: job.keys[id], sabKey: job.keys.sabnzbd, admin: config.admin });
    }
    if (id === 'prowlarr') {
      const apps = ['sonarr', 'radarr'].filter(has).map((a) => ({ id: a, port: byId[a].port, key: job.keys[a] }));
      // Prowlarr pushes indexers into Sonarr/Radarr, so they have to be up first.
      await Promise.all(apps.map((a) => waitFor(`${base(a.id)}/ping`)));
      return configureProwlarr({ base: base(id), key: job.keys.prowlarr, apps, indexers: config.indexers, admin: config.admin });
    }
    if (id === 'sabnzbd') return checkSab({ base: base(id), key: job.keys.sabnzbd, hasServer: !!config.usenet });
    if (id === 'jellyfin') {
      if (!config.admin) return { manual: 'Running - finish its first-run screens' };
      return configureJellyfin({ base: base(id), admin: config.admin });
    }
    if (id === 'plex') {
      if (!config.plexClaim) return { manual: 'Running - sign in to claim it' };
      let token = null;
      for (let i = 0; i < 30 && !token; i++) { token = readPlexToken(cfg('plex')); if (!token) await new Promise((r) => setTimeout(r, 2000)); }
      if (!token) return { manual: 'Running, but the claim token didn\'t take (they expire after 4 minutes) - sign in to claim it' };
      return configurePlex({ base: base(id), token });
    }
    return { manual: 'Running - needs your sign-in' };
  }

  return job;
}

// What the browser is allowed to see: no passwords, keys only for the notes.
export function publicJob(job) {
  const fill = (t) => t.replace(/\{(sonarr|radarr)\}/g, (_, k) => job.keys[k] ||'shown in its Settings → General');
  return {
    running: job.running,
    failed: job.failed,
    steps: job.steps,
    manual: job.manual.map((m) => ({ ...m, port: byId[m.service].port, name: byId[m.service].name, notes: m.notes.map(fill) })),
  };
}
