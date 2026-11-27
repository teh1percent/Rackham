const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STEPS = ['Pick your apps', 'Your settings', 'Review', 'Deploy'];
const GROUPS = { Watch: 'Watch', Automate: 'Find and download', Metrics: 'Metrics', Share: 'Share with others' };
const HOW = { full: 'Set up for you', partial: 'One sign-in needed', manual: 'You finish setup' };
const STATE = { pending: 'Waiting', running: 'Working', done: 'Done', manual: 'Needs you', failed: 'Failed', skipped: 'Skipped' };
const MARK = { done: '✓', manual: '!', failed: '×' };

// Tile colour, and the logo's file name where it differs from the app's id.
const LOOK = {
  plex: { c: '#e5a00d' }, jellyfin: { c: '#aa5cc3' }, tautulli: { c: '#dbb25c' }, tracearr: { c: '#18c8e0' },
  sonarr: { c: '#35c5f4' }, radarr: { c: '#ffc230' }, prowlarr: { c: '#f0733a' }, sabnzbd: { c: '#f5c518' },
  seerr: { c: '#8b7bff', icon: 'overseerr' }, wizarr: { c: '#ef6b6b' },
};
const FOLDER = '<svg class="glyph" viewBox="0 0 20 20" aria-hidden="true"><path d="M2.5 5.5a2 2 0 0 1 2-2h3l2 2h6a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2z"/></svg>';
const UP = '<svg class="glyph line" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 15.5v-11M5 9l5-5 5 5"/></svg>';
const ICONS ='https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/';

const state = {
  step: 0,
  info: null,
  services: new Set(['sonarr', 'radarr', 'prowlarr', 'sabnzbd', 'jellyfin']),
  settings: { tz: '', puid: 1000, pgid: 1000, dataRoot: './data' },
  admin: { username: '', password: '' },
  usenet: { host: '', port: 563, ssl: true, username: '', password: '', connections: 20 },
  indexers: [{ name: '', url: '', apiKey: '' }],
  plexClaim: '',
  jellyfin: { serverName: '', language: 'en', country: 'US' },
  files: null,
  job: null,
};

const has = (id) => state.services.has(id);
const catalog = () => state.info.catalog;
const app = (id) => catalog().find((s) => s.id === id);
const picked = () => catalog().filter((s) => has(s.id));

async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

const payload = () => ({
  services: [...state.services],
  settings: state.settings,
  admin: state.admin,
  usenet: state.usenet,
  indexers: state.indexers,
  plexClaim: state.plexClaim,
  jellyfin: state.jellyfin,
});

function showError(message) {
  const el = $('#error');
  el.hidden = !message;
  el.textContent = message || '';
}

// App logo, with the app's initials as a stand-in when the logo can't load.
function icon(s, small = false) {
  const look = LOOK[s.id] || {};
  return `<span class="icon${small ? ' small' : ''}" style="--c:${look.c || ''}">
    <img src="${ICONS}${look.icon || s.id}.svg" alt="" loading="lazy" onerror="this.parentElement.classList.add('noimg');this.remove()">
    <span class="mono">${esc(s.name.slice(0, 2))}</span></span>`;
}

// Why an app can't be picked yet, or '' if it can.
function blocked(s) {
  const miss = s.requires.filter((r) => !has(r));
  if (miss.length) return `Needs ${miss.map((r) => app(r).name).join(' and ')}`;
  if (s.requiresAny.length && !s.requiresAny.some(has)) return `Needs ${s.requiresAny.map((r) => app(r).name).join(' or ')}`;
  return '';
}

function toggle(id) {
  if (has(id)) state.services.delete(id); else state.services.add(id);
  // Drop anything whose requirement just went away.
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of catalog()) if (has(s.id) && blocked(s)) { state.services.delete(s.id); changed = true; }
  }
  render();
}

// ---------- your stack ----------

function renderRack() {
  const status = Object.fromEntries((state.job?.steps || []).filter((s) => s.service).map((s) => [s.service, s.status]));
  const live = state.step === 3;
  const units = picked().map((s) => `
    <li class="unit" data-status="${live ? status[s.id] || 'idle' : 'idle'}">
      ${icon(s, true)}
      <span>${esc(s.name)}${live && status[s.id] ? `<small>${STATE[status[s.id]]}</small>` : ''}</span>
      <span class="port">:${s.port}</span>
      <span class="led"></span>
    </li>`);
  if (!units.length) units.push('<li class="unit empty">Nothing picked yet</li>');
  $('#rack').innerHTML = units.join('');
  const n = picked().length;
  $('#rack-note').textContent = n ? `${n} app${n > 1 ? 's' : ''}. The number is the port each one answers on.` : '';
}

// ---------- views ----------

const card = (title, body, desc = '') => `<section class="card"><h3>${title}</h3>${desc ? `<p class="desc">${desc}</p>` : ''}${body}</section>`;

function viewPick() {
  return `
    <h2>Pick your apps</h2>
    <p class="lead">Choose what goes in the stack. You enter your settings once and they are applied to every app.</p>
    ${Object.entries(GROUPS).map(([g, title]) => `
      <div class="group">
        <h3>${title}</h3>
        <div class="apps">
          ${catalog().filter((s) => s.group === g).map((s) => {
            const why = blocked(s);
            return `<button type="button" class="app" data-app="${s.id}" aria-pressed="${has(s.id)}" ${why ? 'disabled' : ''}>
              ${icon(s)}
              <strong>${esc(s.name)}</strong>
              <span class="blurb">${esc(s.blurb)}</span>
              <span class="pill ${why ? 'blocked' : s.auto}">${why || HOW[s.auto]}</span>
              <span class="tick"><svg viewBox="0 0 12 12"><path d="M2 6.2 4.8 9 10 3.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
            </button>`;
          }).join('')}
        </div>
      </div>`).join('')}`;
}

const field = (label, bind, { type = 'text', hint = '', wide = false, attrs = '' } = {}) => {
  const [group, key] = bind.split('.');
  const value = key ? state[group][key] : state[group];
  return `<label class="${wide ? 'wide' : ''}">${label}
    <input type="${type}" data-bind="${bind}" value="${esc(value)}" ${attrs}>
    ${hint ? `<span class="hint">${hint}</span>` : ''}</label>`;
};

const LANGUAGES = { en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese', nl: 'Dutch', sv: 'Swedish', no: 'Norwegian', da: 'Danish', fi: 'Finnish', pl: 'Polish', ja: 'Japanese', ko: 'Korean', zh: 'Chinese' };
const COUNTRIES = { US: 'United States', GB: 'United Kingdom', CA: 'Canada', AU: 'Australia', NZ: 'New Zealand', IE: 'Ireland', DE: 'Germany', FR: 'France', ES: 'Spain', IT: 'Italy', NL: 'Netherlands', SE: 'Sweden', NO: 'Norway', DK: 'Denmark', FI: 'Finland', PL: 'Poland', BR: 'Brazil', MX: 'Mexico', JP: 'Japan', KR: 'South Korea' };

const select = (label, bind, options, hint = '') => {
  const [group, key] = bind.split('.');
  return `<label>${label}
    <select data-bind="${bind}">${Object.entries(options).map(([v, name]) => `<option value="${v}" ${state[group][key] === v ? 'selected' : ''}>${name}</option>`).join('')}</select>
    ${hint ? `<span class="hint">${hint}</span>` : ''}</label>`;
};

function viewSettings() {
  const loginFor = ['sonarr', 'radarr', 'prowlarr', 'sabnzbd', 'jellyfin'].filter(has).map((id) => app(id).name);
  return `
    <h2>Your settings</h2>
    <p class="lead">Anything you leave blank is skipped, and you can fill it in later inside the app.</p>

    ${card('Server', `<div class="fields">
      <label class="wide">Media and downloads folder
        <span class="with-btn">
          <input type="text" data-bind="settings.dataRoot" value="${esc(state.settings.dataRoot)}">
          <button type="button" class="btn" data-browse>${FOLDER}Browse</button>
        </span>
        <span class="hint">A folder on the server. Downloads and your library both live here. Type a new name to have it created.</span>
      </label>
      ${field('Timezone', 'settings.tz')}
      ${field('User ID', 'settings.puid', { type: 'number', hint: state.info.rootless ? 'This server runs rootless Docker, where 0 means the account Docker runs as. Keep both at 0 so the apps can write to your folders.' : 'Run <code>id</code> on the server' })}
      ${field('Group ID', 'settings.pgid', { type: 'number' })}
    </div>`)}

    ${loginFor.length ? card('One login', `<div class="fields">
      ${field('Username', 'admin.username', { attrs: 'autocomplete="off"' })}
      ${field('Password', 'admin.password', { type: 'password', hint: 'At least 8 characters', attrs: 'autocomplete="new-password"' })}
    </div>`, `Used for ${esc(loginFor.join(', '))}.`) : ''}

    ${has('jellyfin') ? card('Jellyfin', `<div class="fields">
      ${field('Server name', 'jellyfin.serverName', { wide: true, hint: 'What people see when they connect, for example "Dave\'s Tube". Leave blank to keep Jellyfin\'s default.' })}
      ${select('Metadata language', 'jellyfin.language', LANGUAGES, 'For titles, descriptions and artwork.')}
      ${select('Country', 'jellyfin.country', COUNTRIES, 'For release dates and age ratings.')}
    </div>`, 'Applied along with the Movies and Shows libraries. Needs the login above.') : ''}

    ${has('sabnzbd') ? card('Usenet provider', `<div class="fields">
      ${field('Server', 'usenet.host', { hint: 'For example news.example.com' })}
      ${field('Port', 'usenet.port', { type: 'number' })}
      ${field('Username', 'usenet.username', { attrs: 'autocomplete="off"' })}
      ${field('Password', 'usenet.password', { type: 'password', attrs: 'autocomplete="new-password"' })}
      ${field('Connections', 'usenet.connections', { type: 'number' })}
      <label class="check"><input type="checkbox" data-bind="usenet.ssl" ${state.usenet.ssl ? 'checked' : ''}> Use SSL</label>
    </div>`, 'Added to SABnzbd so it can start downloading.') : ''}

    ${has('prowlarr') ? card('Usenet indexers', `<div>
      ${state.indexers.map((ix, i) => `
        <div class="indexer">
          <input type="text" aria-label="Indexer name" placeholder="Name" data-ix="${i}.name" value="${esc(ix.name)}">
          <input type="url" aria-label="Indexer address" placeholder="https://api.example.com" data-ix="${i}.url" value="${esc(ix.url)}">
          <span class="secret-field">
            <input type="password" aria-label="Indexer API key" placeholder="API key" data-ix="${i}.apiKey" value="${esc(ix.apiKey)}" autocomplete="off" data-bwignore data-lpignore="true" data-1p-ignore>
            <button type="button" data-reveal aria-label="Show API key">Show</button>
          </span>
          <button type="button" class="btn small ghost" data-remove-ix="${i}">Remove</button>
        </div>`).join('')}
      <button type="button" class="btn small" data-add-ix>Add another indexer</button>
    </div>`, 'Added to Prowlarr, which shares them with Sonarr and Radarr.') : ''}

    ${has('plex') ? card('Plex', `<div class="fields">
      ${field('Claim token', 'plexClaim', { wide: true, hint: 'Get one at <a href="https://plex.tv/claim" target="_blank" rel="noopener">plex.tv/claim</a> just before you deploy. It expires after 4 minutes.' })}
    </div>`, 'Links the new server to your Plex account.') : ''}`;
}

// ---------- folder picker ----------

const browser = { path: '', shown: 0 };

async function browseTo(target) {
  const turn = ++browser.shown; // ignore answers that arrive after a newer click
  $('#b-error').hidden = true;
  $('#b-list').innerHTML = '<li class="b-note">Looking…</li>';
  try {
    const r = await api(`/api/browse?path=${encodeURIComponent(target)}`);
    if (turn !== browser.shown) return;
    browser.path = r.path;
    $('#b-path').textContent = r.places ? 'Start from one of these' : r.path;
    $('[data-b-use]').disabled = !!r.places;
    const rows = [];
    // An empty parent means "back to the starting list".
    if (r.parent !== null && r.parent !== undefined) rows.push(`<li><button type="button" class="b-row up" data-b-go="${esc(r.parent)}">${UP}${r.parent === '' ? 'Back to the start' : 'Up one level'}</button></li>`);
    for (const d of r.dirs) rows.push(`<li><button type="button" class="b-row" data-b-go="${esc(d.path)}">${FOLDER}<span>${esc(d.name)}${d.note ? `<small>${esc(d.note)}</small>` : ''}</span></button></li>`);
    if (!r.dirs.length) rows.push('<li class="b-note">No folders in here. You can still use this one.</li>');
    $('#b-list').innerHTML = rows.join('');
    $('#b-list').scrollTop = 0;
  } catch (err) {
    if (turn !== browser.shown) return;
    // A typed path that doesn't exist yet: start from the top instead.
    if (target) return browseTo('');
    $('#b-list').innerHTML = '';
    $('#b-error').textContent = err.message;
    $('#b-error').hidden = false;
  }
}

function openBrowser() {
  const current = state.settings.dataRoot.trim();
  $('#b-path').textContent = '';
  $('#browser').showModal();
  browseTo(/^(\/|[A-Za-z]:[\\/])/.test(current) ? current : '');
}

function download(name, textContent) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([textContent], { type: 'text/plain' }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

// The server marks API keys in a note as [[secret:...]]; they stay hidden until asked for.
const note = (text) => esc(text).replace(/\[\[secret:([^\]]+)\]\]/g, (_, key) => `<span class="secret" data-secret="${key}"><code>${'•'.repeat(12)}</code> <button type="button" data-show-secret>Show</button></span>`);

// `linked` is false before deploy, when there is nothing to open yet.
function todoList(items, linked = true) {
  return `<ul class="todo">${items.map((m) => {
    const s = app(m.service);
    const title = linked ? `<a href="http://${location.hostname}:${s.port}${m.path}" target="_blank" rel="noopener">${esc(m.title)}</a>` : `<strong>${esc(m.title)}</strong>`;
    return `<li>${icon(s, true)}<div>${title}${m.notes.map((n) => `<p>${note(n)}</p>`).join('')}</div></li>`;
  }).join('')}</ul>`;
}

function viewReview() {
  const f = state.files;
  const auto = picked().filter((s) => !f.manual.some((m) => m.service === s.id)).map((s) => s.name);
  return `
    <h2>Review</h2>
    <p class="lead">Nothing has been written or started yet.</p>
    ${state.info.docker ? '' : '<p class="notice">Docker isn\'t reachable from where this setup app is running, so it can\'t deploy. Download the two files and run <code>docker compose up -d</code> on your server. The apps will start, but you connect them yourself.</p>'}
    ${card('Summary', `<ul class="summary">
      <li><span>Apps</span><span>${esc(picked().map((s) => s.name).join(', '))}</span></li>
      <li><span>Data folder</span><span>${esc(state.settings.dataRoot)}</span></li>
      <li><span>Saved to</span><span>${esc(state.info.stackDir)}</span></li>
      <li><span>Set up for you</span><span>${esc(auto.join(', ') || 'Nothing')}</span></li>
    </ul>`)}
    ${f.manual.length ? card('Left for you after deploy', todoList(f.manual.map((m) => ({ ...m, notes: [] })), false)) : ''}
    ${card('Files', `<div>
      <details><summary>docker-compose.yml</summary><pre>${esc(f.compose)}</pre></details>
      <details><summary>.env</summary><pre>${esc(f.env)}</pre></details>
    </div>`, 'What will be written to the server.')}`;
}

function viewDeploy() {
  const j = state.job;
  const up = j.steps.find((s) => s.id === 'up')?.status === 'done';
  return `
    <h2>${j.running ? 'Deploying' : j.failed ? 'Finished with problems' : 'Your stack is running'}</h2>
    <p class="lead">${j.running ? 'The first run downloads every app, so this can take several minutes.' : j.failed ? 'Fix what failed, then deploy again. Deploying twice is safe: nothing is added a second time.' : 'Everything that could be set up for you is done.'}</p>
    ${card('Progress', `<ol class="progress">
      ${j.steps.map((s) => `<li data-status="${s.status}">
        <span class="dot">${MARK[s.status] || ''}</span>
        <span class="label">${esc(s.label)}<span class="detail">${esc(s.detail)}</span></span>
        <span class="state">${STATE[s.status]}</span></li>`).join('')}
    </ol>`)}
    ${!j.running && up ? `
      ${state.blocked?.length ? `<p class="notice">Your browser can't reach ${esc(state.blocked.map((s) => s.name).join(', '))}. The apps are running, so the server's firewall is most likely blocking them. Open ${state.blocked.length > 1 ? 'these TCP ports' : 'this TCP port'} on the server, then reload this page: <strong>${state.blocked.map((s) => s.port).join(', ')}</strong></p>` : ''}
      ${card('Open your apps', `<div class="links">${picked().map((s) => `<a href="http://${location.hostname}:${s.port}" target="_blank" rel="noopener">${icon(s, true)}${esc(s.name)}</a>`).join('')}</div>`)}
      ${j.manual.length ? card('Left for you', todoList(j.manual)) : ''}` : ''}`;
}

// ---------- shell ----------

function render() {
  showError('');
  renderRack();
  $('#steps').innerHTML = STEPS.map((s, i) => `<li class="${i < state.step ? 'past' : ''}" ${i === state.step ? 'aria-current="step"' : ''}><span class="n">${i < state.step ? '✓' : i + 1}</span><span>${s}</span></li>`).join('');
  $('#view').innerHTML = [viewPick, viewSettings, viewReview, viewDeploy][state.step]();

  const a = [];
  if (state.step > 0 && state.step < 3) a.push('<button type="button" class="btn" data-act="back">Back</button>');
  a.push('<span class="spacer"></span>');
  if (state.step === 0) a.push(`<button type="button" class="btn primary" data-act="next" ${state.services.size ? '' : 'disabled'}>Continue to settings</button>`);
  if (state.step === 1) a.push('<button type="button" class="btn primary" data-act="review">Review</button>');
  if (state.step === 2) {
    a.push('<button type="button" class="btn" data-act="download">Download files</button>');
    a.push(`<button type="button" class="btn primary" data-act="deploy" ${state.info.docker ? '' : 'disabled'}>Deploy</button>`);
  }
  if (state.step === 3 && !state.job.running) {
    a.push('<button type="button" class="btn" data-act="edit">Change settings</button>');
    if (state.job.failed) a.push('<button type="button" class="btn primary" data-act="deploy">Deploy again</button>');
  }
  $('#actions').innerHTML = a.length > 1 ? a.join('') : '';
}

// After a deploy, tries each app from this browser. Apps that are running on
// the server but don't answer here are usually behind the server's firewall.
async function checkReachable() {
  const j = state.job;
  if (!j || j.running || j.steps.find((s) => s.id === 'up')?.status !== 'done') return;
  const tried = await Promise.all(picked().map(async (s) => {
    try {
      await fetch(`http://${location.hostname}:${s.port}/`, { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(5000) });
      return null;
    } catch { return s; }
  }));
  state.blocked = tried.filter(Boolean);
  if (state.step === 3 && state.blocked.length) render();
}

async function poll() {
  while (state.job?.running) {
    await new Promise((r) => setTimeout(r, 1500));
    try { state.job = await api('/api/job'); } catch { continue; }
    if (state.step === 3) render();
  }
  checkReachable();
}

const go = (step) => { state.step = step; render(); window.scrollTo(0, 0); };

const acts = {
  back: () => go(state.step - 1),
  next: () => go(1),
  edit: () => go(1),
  review: async () => { state.files = await api('/api/files', payload()); go(2); },
  download: () => { download('docker-compose.yml', state.files.compose); download('.env', state.files.env); },
  deploy: async () => { state.blocked = []; state.job = await api('/api/deploy', payload()); go(3); poll(); },
};

document.addEventListener('click', async (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.app) return toggle(t.dataset.app);
  if ('browse' in t.dataset) return openBrowser();
  if ('reveal' in t.dataset) {
    const input = t.parentElement.querySelector('input');
    const hidden = input.type === 'password';
    input.type = hidden ? 'text' : 'password';
    t.textContent = hidden ? 'Hide' : 'Show';
    t.setAttribute('aria-label', hidden ? 'Hide API key' : 'Show API key');
    return;
  }
  if ('showSecret' in t.dataset) {
    const box = t.parentElement;
    const hidden = t.textContent === 'Show';
    box.querySelector('code').textContent = hidden ? box.dataset.secret : '•'.repeat(12);
    t.textContent = hidden ? 'Hide' : 'Show';
    return;
  }
  if ('bGo' in t.dataset) return browseTo(t.dataset.bGo);
  if ('bCancel' in t.dataset) return $('#browser').close();
  if ('bUse' in t.dataset) {
    if (browser.path) state.settings.dataRoot = browser.path;
    $('#browser').close();
    return render();
  }
  if ('addIx' in t.dataset) { state.indexers.push({ name: '', url: '', apiKey: '' }); return render(); }
  if (t.dataset.removeIx) {
    state.indexers.splice(Number(t.dataset.removeIx), 1);
    if (!state.indexers.length) state.indexers.push({ name: '', url: '', apiKey: '' });
    return render();
  }
  if (t.dataset.act) {
    t.disabled = true;
    try { await acts[t.dataset.act](); } catch (err) { showError(err.message); }
    if (t.isConnected) t.disabled = false;
  }
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.bind) {
    const [group, key] = t.dataset.bind.split('.');
    const value = t.type === 'checkbox' ? t.checked : t.type === 'number' ? Number(t.value) : t.value;
    if (key) state[group][key] = value; else state[group] = value;
  } else if (t.dataset.ix) {
    const [i, key] = t.dataset.ix.split('.');
    state.indexers[Number(i)][key] = t.value;
  }
});

state.info = await api('/api/info');
state.settings.tz = state.info.timezone || 'Etc/UTC';
if (state.info.rootless) { state.settings.puid = 0; state.settings.pgid = 0; }
if (state.info.job) {
  state.job = state.info.job;
  state.services = new Set(state.job.steps.filter((s) => s.service).map((s) => s.service));
  state.step = 3;
  poll();
}
render();
