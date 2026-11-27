import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicCatalog } from './lib/catalog.js';
import { normalize, buildCompose, buildEnv } from './lib/compose.js';
import { newKey, tracearrSecrets } from './lib/seed.js';
import { createJob, publicJob, dockerInfo, manualSteps, inContainer, browse } from './lib/deploy.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, 'public');
const PORT = Number(process.env.PORT) || 8099;
// Where the compose file, .env and app settings are written. When this app runs
// in a container, this folder must be mounted at the same path as on the host.
const STACK_DIR = path.resolve(process.env.STACK_DIR || path.join(here, 'stack'));

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

let job = null;

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 200000) { reject(new Error('Request too large.')); req.destroy(); } });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('Request was not valid JSON.')); } });
    req.on('error', reject);
  });
}

const routes = {
  'GET /api/info': async () => ({
    catalog: publicCatalog(),
    docker: (await dockerInfo()).available,
    inContainer,
    stackDir: STACK_DIR,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    job: job ? publicJob(job) : null,
  }),

  // Preview only: nothing is written or started.
  'POST /api/files': async (req) => {
    const config = normalize(await readJson(req));
    config.selinux = (await dockerInfo()).selinux;
    // Stand-in values so the preview looks like the real thing; deploy makes its own.
    const keys = { sonarr: newKey(), radarr: newKey(), prowlarr: newKey(), tracearr: tracearrSecrets('') };
    return { compose: buildCompose(config), env: buildEnv(config, keys), manual: manualSteps(config) };
  },

  'POST /api/deploy': async (req) => {
    if (job?.running) throw new Error('A deploy is already running.');
    const config = normalize(await readJson(req));
    const docker = await dockerInfo();
    if (!docker.available) throw new Error('Docker isn\'t reachable from here, so nothing was started. Download the files instead.');
    config.selinux = docker.selinux;
    job = createJob(config, STACK_DIR);
    return publicJob(job);
  },

  'GET /api/job': async () => (job ? publicJob(job) : null),

  // Folder names only, for the folder picker. Never file names or contents.
  'GET /api/browse': async (req, url) => browse(url.searchParams.get('path') || ''),
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const route = routes[`${req.method} ${url.pathname}`];
  if (route) {
    // Changes must come from this page, not from another site open in the same browser.
    if (req.method === 'POST' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return send(res, 403, { error: 'Cross-site request refused.' });
    try { return send(res, 200, await route(req, url)); } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (req.method !== 'GET') return send(res, 404, { error: 'Not found.' });

  const file = path.join(PUBLIC, path.normalize(url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 404, { error: 'Not found.' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'Not found.' });
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`Rackham is ready at http://localhost:${PORT}  (files go to ${STACK_DIR})`));
