import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalize, buildCompose, buildEnv } from '../lib/compose.js';
import { buildSabIni, seedArr, seedSab, tracearrSecrets } from '../lib/seed.js';
import { manualSteps, planSteps } from '../lib/deploy.js';
import { SERVICES } from '../lib/catalog.js';

const all = SERVICES.map((s) => s.id);

test('compose contains only the picked apps', () => {
  const yaml = buildCompose(normalize({ services: ['sonarr', 'sabnzbd'] }));
  assert.match(yaml, /^  sonarr:$/m);
  assert.match(yaml, /^  sabnzbd:$/m);
  assert.doesNotMatch(yaml, /radarr|plex|jellyfin/);
  assert.match(yaml, /- "8989:8989"/);
  assert.match(yaml, /- "\$\{DATA_ROOT\}:\/data"/);
});

test('full stack compose has every app, and tautulli waits for plex', () => {
  const yaml = buildCompose(normalize({ services: all }));
  for (const id of all) assert.match(yaml, new RegExp(`container_name: ${id}$`, 'm'));
  assert.match(yaml, /depends_on:\n      - plex/);
  assert.match(yaml, /init: true/);
});

test('apps with unmet requirements are refused', () => {
  assert.throws(() => normalize({ services: ['tautulli'] }), /Tautulli needs Plex/);
  assert.throws(() => normalize({ services: ['seerr'] }), /Seerr needs Plex or Jellyfin/);
  assert.throws(() => normalize({ services: [] }), /at least one/);
});

test('bad input is refused before it reaches a file', () => {
  const base = { services: ['sonarr'] };
  assert.throws(() => normalize({ ...base, settings: { dataRoot: '/data\nEVIL=1' } }), /data folder/);
  assert.throws(() => normalize({ ...base, settings: { dataRoot: '/data$(rm)' } }), /data folder/);
  assert.throws(() => normalize({ ...base, settings: { tz: 'x; y' } }), /Timezone/);
  assert.throws(() => normalize({ ...base, settings: { puid: 'abc' } }), /User ID/);
  assert.throws(() => normalize({ ...base, admin: { username: 'me', password: 'short' } }), /8 characters/);
  assert.throws(() => normalize({ services: ['plex'], plexClaim: 'nope' }), /claim-/);
});

test('.env carries settings and only the needed keys', () => {
  const config = normalize({ services: ['sonarr', 'plex'], settings: { dataRoot: 'D:\\My Media', tz: 'Europe/London', puid: 99, pgid: 100 }, plexClaim: 'claim-abcdef123' });
  const env = buildEnv(config, { sonarr: 'k1', radarr: 'k2' });
  assert.match(env, /^PUID=99$/m);
  assert.match(env, /^DATA_ROOT='D:\\My Media'$/m);
  assert.match(env, /^PLEX_CLAIM=claim-abcdef123$/m);
  assert.match(env, /^SONARR_API_KEY=k1$/m);
  assert.doesNotMatch(env, /RADARR/);
});

test('sabnzbd.ini has folders, whitelist, server and categories', () => {
  const ini = buildSabIni({
    apiKey: 'abc', nzbKey: 'def', admin: { username: 'me', password: 'pass word,1' },
    usenet: { host: 'news.example.com', port: 563, ssl: true, username: 'u', password: 'p#1', connections: 20 },
  });
  assert.match(ini, /^api_key = abc$/m);
  assert.match(ini, /^complete_dir = \/data\/usenet\/complete$/m);
  assert.match(ini, /^host_whitelist = sabnzbd,$/m);
  assert.match(ini, /^password = "pass word,1"$/m);
  assert.match(ini, /^\[\[news\.example\.com\]\]$/m);
  assert.match(ini, /^password = "p#1"$/m);
  assert.match(ini, /^\[\[tv\]\]$/m);
});

test('seeding keeps an existing key instead of overwriting it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mss-'));
  const first = seedArr(path.join(dir, 'sonarr'), 1000, 1000);
  const again = seedArr(path.join(dir, 'sonarr'), 1000, 1000);
  assert.equal(first.existing, false);
  assert.equal(again.existing, true);
  assert.equal(again.key, first.key);

  const sab = seedSab(path.join(dir, 'sabnzbd'), 1000, 1000, { admin: null, usenet: null });
  assert.equal(seedSab(path.join(dir, 'sabnzbd'), 1000, 1000, { admin: null, usenet: null }).key, sab.key);
  fs.rmSync(dir, { recursive: true });
});

test('manual steps shrink as the user supplies more', () => {
  const bare = manualSteps(normalize({ services: all })).map((m) => m.service);
  assert.deepEqual(bare, ['plex', 'jellyfin', 'sabnzbd', 'prowlarr', 'tautulli', 'tracearr', 'seerr', 'wizarr']);
  const full = manualSteps(normalize({
    services: all,
    admin: { username: 'me', password: 'longenough' },
    usenet: { host: 'news.example.com', username: 'u', password: 'p' },
    indexers: [{ name: 'Geek', url: 'https://api.example.com', apiKey: 'abcd1234' }],
    plexClaim: 'claim-abcdef123',
  })).map((m) => m.service);
  assert.deepEqual(full, ['tautulli', 'tracearr', 'seerr', 'wizarr']);
});

test('tracearr brings its database, cache, volumes and secrets', () => {
  const config = normalize({ services: ['jellyfin', 'tracearr'] });
  const yaml = buildCompose(config);
  assert.match(yaml, /^  tracearr-db:$/m);
  assert.match(yaml, /^  tracearr-redis:$/m);
  assert.match(yaml, /depends_on:\n      tracearr-db:\n        condition: service_healthy/);
  assert.match(yaml, /test:\n        - CMD-SHELL\n        - pg_isready -U tracearr/);
  assert.match(yaml, /^volumes:\n  tracearr_backups: \{\}/m);
  assert.doesNotMatch(buildCompose(normalize({ services: ['jellyfin'] })), /tracearr|^volumes:/m);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mss-'));
  const first = tracearrSecrets(path.join(dir, '.env'));
  fs.writeFileSync(path.join(dir, '.env'), buildEnv(config, { tracearr: first }));
  assert.deepEqual(tracearrSecrets(path.join(dir, '.env')), first);
  fs.rmSync(dir, { recursive: true });
  assert.throws(() => normalize({ services: ['tracearr'] }), /Tracearr needs Plex or Jellyfin/);
});

test('SELinux hosts get labelling turned off for apps that mount host folders', () => {
  const config = normalize({ services: ['jellyfin', 'tracearr'] });
  assert.doesNotMatch(buildCompose(config), /security_opt/);
  const yaml = buildCompose({ ...config, selinux: true });
  assert.equal(yaml.match(/security_opt:\n      - label=disable$/gm).length, 1); // jellyfin only; tracearr uses named volumes
});

test('the plan has one step per app after the three shared ones', () => {
  const steps = planSteps(normalize({ services: ['sonarr', 'radarr'] }));
  assert.deepEqual(steps.map((s) => s.id), ['files', 'folders', 'up', 'sonarr', 'radarr']);
});
