// Tests for background.js, run with:  node test/background.test.js
//
// Loads the real service worker source into a vm context with a stubbed
// `chrome` API and a `fetch` that routes plex.tv / Radarr calls to fake HTTP
// servers started here. No dependencies.
const http = require('http');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

let src = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
src = src.replace('const PLEX_PIN_POLL_MS = 2000;', 'const PLEX_PIN_POLL_MS = 40;');

// ---- chrome stub -----------------------------------------------------------
let local = {};
let session = {};
let permissionGranted = true;
const calls = { windowsCreate: [], windowsRemove: [], tabsCreate: [], badge: [], openOptions: 0 };
const listeners = { storage: [], windowsRemoved: [], tabsRemoved: [], message: [], actionClicked: [] };

function pick(store, keys) {
  if (keys === null || keys === undefined) return { ...store };
  const out = {};
  for (const k of (Array.isArray(keys) ? keys : [keys])) if (k in store) out[k] = store[k];
  return out;
}
function fireStorage(changes) {
  for (const fn of listeners.storage) fn(changes, 'local');
}
const chrome = {
  storage: {
    local: {
      get: async (keys) => pick(local, keys),
      set: async (o) => { const ch = {}; for (const k of Object.keys(o)) ch[k] = { oldValue: local[k], newValue: o[k] }; Object.assign(local, o); fireStorage(ch); },
      remove: async (keys) => { const ch = {}; for (const k of (Array.isArray(keys) ? keys : [keys])) { if (k in local) { ch[k] = { oldValue: local[k] }; delete local[k]; } } if (Object.keys(ch).length) fireStorage(ch); }
    },
    session: {
      get: async (keys) => pick(session, keys),
      set: async (o) => { Object.assign(session, o); },
      remove: async (keys) => { for (const k of (Array.isArray(keys) ? keys : [keys])) delete session[k]; }
    },
    onChanged: { addListener: (fn) => listeners.storage.push(fn) }
  },
  runtime: {
    getManifest: () => ({ version: '2.2.0' }),
    onMessage: { addListener: (fn) => listeners.message.push(fn) },
    openOptionsPage: async () => { calls.openOptions++; }
  },
  permissions: { contains: async () => permissionGranted },
  action: {
    onClicked: { addListener: (fn) => listeners.actionClicked.push(fn) },
    setBadgeText: ({ text }) => calls.badge.push(text),
    setBadgeBackgroundColor: () => {}
  },
  windows: {
    create: async (opts) => { calls.windowsCreate.push(opts); return { id: 77 }; },
    remove: async (id) => { calls.windowsRemove.push(id); },
    onRemoved: { addListener: (fn) => listeners.windowsRemoved.push(fn) }
  },
  tabs: {
    create: async (opts) => { calls.tabsCreate.push(opts); return { id: 9 }; },
    remove: async () => {},
    onRemoved: { addListener: (fn) => listeners.tabsRemoved.push(fn) }
  }
};

// fetch that redirects Plex hostnames to the fake plex.tv server.
let plexBase = '';
const routedFetch = (url, opts) => {
  const u = String(url).replace(/^https:\/\/plex\.tv/, plexBase);
  return fetch(u, opts);
};

const ctx = { chrome, fetch: routedFetch, AbortController, setTimeout, clearTimeout, console, crypto, URL, URLSearchParams, encodeURIComponent, JSON, Math, Promise, Date };
vm.createContext(ctx);
vm.runInContext(src + '\n;globalThis.__api = { radarrResolve, radarrAdd, radarrTest, plexResolve, normalizeRadarrUrl, radarrOriginPattern, plexSignInStart, plexSignInStatus, plexSignInCancel, plexSignOut, getPlexHeaders, radarrHasFile };', ctx);
const api = ctx.__api;

// ---- tiny assert -----------------------------------------------------------
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(pred, timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await pred()) return true; await sleep(15); }
  return false;
}
function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

// ---- fake plex.tv ----------------------------------------------------------
const plex = { pinPolls: 0, claimAfter: 2, pinGone: false, lastPinHeaders: null, token: 'tok-123' };
const plexServer = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (u.pathname === '/api/v2/pins' && req.method === 'POST') {
    plex.lastPinHeaders = req.headers;
    plex.pinPolls = 0;
    return send(201, { id: 555, code: 'ABCD1234', expiresIn: 1800, authToken: null });
  }
  if (u.pathname === '/api/v2/pins/555') {
    if (plex.pinGone) return send(404, { errors: [{ code: 1020, message: 'Code not found or expired' }] });
    plex.pinPolls++;
    return send(200, { id: 555, code: 'ABCD1234', authToken: plex.pinPolls >= plex.claimAfter ? plex.token : null });
  }
  if (u.pathname === '/api/v2/user') {
    if (req.headers['x-plex-token'] !== plex.token) return send(401, {});
    return send(200, { username: 'mattcoady' });
  }
  if (u.pathname === '/api/v2/resources') {
    return send(200, [{ name: 'Mattflix', provides: 'server', connections: [] }, { name: 'Living Room TV', provides: 'player', connections: [] }]);
  }
  send(404, {});
});

// ---- fake Radarr -----------------------------------------------------------
const catalog = {
  'tt1375666': { tmdbId: 27205, title: 'Inception', year: 2010, titleSlug: '27205', imdbId: 'tt1375666', images: [{ coverType: 'poster', remoteUrl: 'x' }] },
  'tt0111161': { tmdbId: 278, title: 'The Shawshank Redemption', year: 1994, titleSlug: '278', imdbId: 'tt0111161' }
};
// Shaped like Radarr v5: no hasFile, the file shows up as movieFileId/movieFile.
const library = new Map([[278, { id: 42, ...catalog['tt0111161'], movieFileId: 12, movieFile: { id: 12, relativePath: 'The Shawshank Redemption (1994).mkv' }, monitored: true }]]);
let lastPost = null;
let appName = 'Radarr';
let postCount = 0;
const radarrServer = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.headers['x-api-key'] !== 'secret') return send(401, { error: 'Unauthorized' });
  if (u.pathname === '/api/v3/system/status') return send(200, { appName, instanceName: 'Radarr (NAS)', version: '5.12.1.9300' });
  if (u.pathname === '/api/v3/qualityprofile') return send(200, [{ id: 1, name: 'Any' }, { id: 4, name: 'HD-1080p' }]);
  if (u.pathname === '/api/v3/rootfolder') return send(200, [{ id: 1, path: '/movies', freeSpace: 812000000000 }]);
  if (u.pathname === '/api/v3/movie/lookup') {
    const term = u.searchParams.get('term') || '';
    let results = [];
    if (term.startsWith('imdb:')) { const m = catalog[term.slice(5)]; if (m) results = [m]; }
    else if (term.startsWith('tmdb:')) { const m = Object.values(catalog).find(x => String(x.tmdbId) === term.slice(5)); if (m) results = [m]; }
    else results = Object.values(catalog).filter(x => term.toLowerCase().includes(x.title.toLowerCase()));
    // Worst case: lookup never reports the library id, forcing the /movie?tmdbId= check.
    return send(200, results.map(m => ({ ...m, id: 0 })));
  }
  if (u.pathname === '/api/v3/movie' && req.method === 'GET') {
    const m = library.get(Number(u.searchParams.get('tmdbId')));
    return send(200, m ? [m] : []);
  }
  if (u.pathname === '/api/v3/movie' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      postCount++;
      const m = JSON.parse(body); lastPost = m;
      if (library.has(m.tmdbId)) return send(400, [{ errorMessage: 'This movie has already been added' }]);
      const added = { ...m, id: 100 + library.size, movieFileId: 0, movieFile: null };
      library.set(m.tmdbId, added);
      send(201, added);
    });
    return;
  }
  send(404, {});
});

(async () => {
  plexBase = await listen(plexServer);
  const base = await listen(radarrServer);

  // =========================================================================
  console.log('Plex headers');
  let h = await api.getPlexHeaders('');
  check('no token -> no X-Plex-Token header', !('X-Plex-Token' in h) && !!h['X-Plex-Client-Identifier'], h);
  h = await api.getPlexHeaders('abc');
  check('token -> X-Plex-Token header', h['X-Plex-Token'] === 'abc');

  // =========================================================================
  console.log('Sign in with Plex');
  local = { cacheTarget_letterboxd_inception: { url: 'x', type: 'search', timestamp: Date.now() } };
  session = { serverCache: { servers: [], timestamp: Date.now() } };
  let r = await api.plexSignInStart();
  check('start -> ok', r && r.ok === true, r);
  check('start -> PIN created without a token header', plex.lastPinHeaders && !plex.lastPinHeaders['x-plex-token'] && plex.lastPinHeaders['x-plex-product'] === 'ReelHop', plex.lastPinHeaders);
  const win = calls.windowsCreate[0];
  check('start -> opens Plex auth in a popup window', win && win.type === 'popup' && win.url.startsWith('https://app.plex.tv/auth#?'), win);
  check('auth url carries clientID, code and product', win && /clientID=reelhop-/.test(win.url) && win.url.includes('code=ABCD1234') && win.url.includes('context%5Bdevice%5D%5Bproduct%5D=ReelHop'), win && win.url);
  r = await api.plexSignInStatus();
  check('status while waiting -> pending', r.status === 'pending', r);
  const done = await waitFor(async () => local.plexToken === 'tok-123');
  check('poll picks up the token', done, local);
  await waitFor(async () => calls.windowsRemove.includes(77));
  check('account details stored with the token', local.plexUsername === 'mattcoady' && JSON.stringify(local.plexServerNames) === '["Mattflix"]', local);
  check('sign-in window closed', calls.windowsRemove.includes(77), calls.windowsRemove);
  check('toolbar badge shown', calls.badge.includes('✓'), calls.badge);
  check('token change drops film cache and server cache', !('cacheTarget_letterboxd_inception' in local) && !('serverCache' in session), { local: Object.keys(local), session: Object.keys(session) });
  // The window close we caused fires onRemoved; it must not flip 'done' to 'cancelled'.
  for (const fn of listeners.windowsRemoved) await fn(77);
  r = await api.plexSignInStatus();
  check('status after success -> done (reported once)', r.status === 'done' && r.username === 'mattcoady', r);
  r = await api.plexSignInStatus();
  check('status afterwards -> idle', r.status === 'idle', r);

  // Expired PIN
  plex.pinGone = true;
  await api.plexSignInStart();
  await waitFor(async () => (await chrome.storage.session.get('plexSignIn')).plexSignIn?.status === 'expired');
  r = await api.plexSignInStatus();
  check('PIN gone -> expired', r.status === 'expired', r);
  plex.pinGone = false;

  // Cancel from the popup
  plex.claimAfter = 999;
  await api.plexSignInStart();
  await api.plexSignInCancel();
  r = await api.plexSignInStatus();
  check('cancel -> cancelled', r.status === 'cancelled', r);

  // User closes the window themselves
  calls.windowsRemove.length = 0;
  await api.plexSignInStart();
  for (const fn of listeners.windowsRemoved) await fn(77);
  r = await api.plexSignInStatus();
  check('window closed by user -> cancelled', r.status === 'cancelled', r);
  check('polling stops after cancel', await (async () => { const before = plex.pinPolls; await sleep(150); return plex.pinPolls === before; })());
  plex.claimAfter = 2;

  // Sign out
  local.cacheTarget_imdb_tt1 = { url: 'x' };
  await api.plexSignOut();
  await sleep(20);
  check('sign out removes token, username, servers', !local.plexToken && !local.plexUsername && !local.plexServerNames, local);
  check('sign out drops film cache', !('cacheTarget_imdb_tt1' in local), Object.keys(local));

  // =========================================================================
  console.log('normalizeRadarrUrl / origin pattern');
  check('adds http://', api.normalizeRadarrUrl('192.168.1.10:7878') === 'http://192.168.1.10:7878');
  check('strips trailing slash, keeps url base', api.normalizeRadarrUrl('https://x.com/radarr/') === 'https://x.com/radarr');
  check('rejects non-http', api.normalizeRadarrUrl('ftp://x') === '');
  check('empty stays empty', api.normalizeRadarrUrl('   ') === '');
  check('origin pattern drops port', api.radarrOriginPattern('http://192.168.1.10:7878') === 'http://192.168.1.10/*');

  console.log('radarrResolve');
  const cfg = (over = {}) => { local = { radarrEnabled: true, radarrUrl: base + '/', radarrApiKey: 'secret', radarrQualityProfileId: 4, radarrRootFolder: '/movies', radarrMinAvailability: 'released', radarrSearchOnAdd: true, ...over }; };
  const inception = { title: 'Inception', year: '2010', imdbId: 'tt1375666', tmdbId: '', type: 'movie' };
  const shawshank = { title: 'The Shawshank Redemption', year: '1994', imdbId: 'tt0111161', tmdbId: '', type: 'movie' };
  cfg();
  r = await api.radarrResolve(shawshank);
  check('in library -> in_library', r.status === 'in_library', r);
  check('in library -> hasFile (from movieFileId) / monitored', r.hasFile === true && r.monitored === true, r);
  check('hasFile: v5 shape, movieFileId only', api.radarrHasFile({ id: 1, movieFileId: 7 }) === true);
  check('hasFile: v5 shape, movieFile only', api.radarrHasFile({ id: 1, movieFile: { id: 7 } }) === true);
  check('hasFile: legacy hasFile:true', api.radarrHasFile({ id: 1, hasFile: true, movieFileId: 0 }) === true);
  check('hasFile: nothing downloaded', api.radarrHasFile({ id: 1, hasFile: null, movieFileId: 0, movieFile: null }) === false);
  check('hasFile: lookup result (not in library)', api.radarrHasFile({ id: 0, tmdbId: 5 }) === false);
  check('in library -> movie url', r.url === `${base}/movie/278`, r.url);
  r = await api.radarrResolve(inception);
  check('not in library -> missing', r.status === 'missing', r);
  check('missing -> canAdd', r.canAdd === true, r);
  check('missing -> add page url with imdb term', r.url === `${base}/add/new?term=imdb%3Att1375666`, r.url);
  r = await api.radarrResolve({ title: 'Nope Nope', year: '1999', imdbId: 'tt0000001', tmdbId: '', type: 'movie' });
  check('unknown -> not_found', r.status === 'not_found', r);
  check('not_found -> search url', r.url === `${base}/add/new?term=Nope%20Nope%201999`, r.url);
  r = await api.radarrResolve({ title: 'Inception', year: '2010', imdbId: '', tmdbId: '27205', type: '' });
  check('tmdb-only lookup works', r.status === 'missing' && r.tmdbId === 27205, r);
  r = await api.radarrResolve({ title: 'The Shawshank Redemption', year: '1994', imdbId: '', tmdbId: '', type: '' });
  check('title-only lookup matches on title+year', r.status === 'in_library', r);
  r = await api.radarrResolve({ title: 'The Shawshank Redemption', year: '2020', imdbId: '', tmdbId: '', type: '' });
  check('title-only lookup rejects wrong year', r.status === 'not_found', r);
  cfg({ radarrQualityProfileId: 0 });
  r = await api.radarrResolve(inception);
  check('no profile -> missing but canAdd=false', r.status === 'missing' && r.canAdd === false, r);
  r = await api.radarrAdd(inception);
  check('no profile -> add refuses (unconfigured)', r.status === 'unconfigured' && postCount === 0, r);
  cfg({ radarrApiKey: 'wrong' });
  r = await api.radarrResolve(inception);
  check('bad key -> unauthorized', r.status === 'unauthorized', r);
  cfg({ radarrApiKey: '' });
  r = await api.radarrResolve(inception);
  check('no key -> unconfigured', r.status === 'unconfigured', r);
  cfg({ radarrEnabled: false });
  r = await api.radarrResolve(inception);
  check('disabled -> disabled', r.status === 'disabled', r);
  cfg(); permissionGranted = false;
  r = await api.radarrResolve(inception);
  check('no host permission -> permission', r.status === 'permission', r);
  permissionGranted = true;
  cfg({ radarrUrl: 'http://127.0.0.1:1' });
  r = await api.radarrResolve(inception);
  check('closed port -> unreachable', r.status === 'unreachable', r);

  console.log('radarrAdd');
  cfg();
  r = await api.radarrAdd(inception);
  check('add -> in_library + justAdded', r.status === 'in_library' && r.justAdded === true, r);
  check('add -> movie url from response slug', r.url === `${base}/movie/27205`, r.url);
  check('POST carries lookup identity', lastPost && lastPost.tmdbId === 27205 && lastPost.title === 'Inception' && lastPost.year === 2010, lastPost);
  check('POST carries profile/root/availability', lastPost.qualityProfileId === 4 && lastPost.rootFolderPath === '/movies' && lastPost.minimumAvailability === 'released', lastPost);
  check('POST monitored + searchForMovie + id 0', lastPost.monitored === true && lastPost.addOptions.searchForMovie === true && lastPost.id === 0, lastPost);
  r = await api.radarrResolve(inception);
  check('after add -> in_library, wanted (no file)', r.status === 'in_library' && r.hasFile === false && r.monitored === true, r);
  postCount = 0;
  r = await api.radarrAdd(shawshank);
  check('add existing -> reports library copy without POST', r.status === 'in_library' && r.alreadyAdded === true && postCount === 0, r);
  cfg({ radarrSearchOnAdd: false, radarrMinAvailability: 'announced' });
  library.delete(27205);
  r = await api.radarrAdd(inception);
  check('add honors searchOnAdd=false and availability', lastPost.addOptions.searchForMovie === false && lastPost.minimumAvailability === 'announced', lastPost);

  console.log('radarrTest');
  r = await api.radarrTest({ url: base, apiKey: 'secret' });
  check('test ok + options', r.ok && r.profiles.length === 2 && r.rootFolders[0].path === '/movies' && r.instanceName === 'Radarr (NAS)' && r.version === '5.12.1.9300', r);
  r = await api.radarrTest({ url: base, apiKey: 'nope' });
  check('test bad key -> unauthorized', !r.ok && r.reason === 'unauthorized', r);
  appName = 'Sonarr';
  r = await api.radarrTest({ url: base, apiKey: 'secret' });
  check('test wrong app -> wrong_app', !r.ok && r.reason === 'wrong_app' && r.appName === 'Sonarr', r);
  appName = 'Radarr';
  r = await api.radarrTest({ url: 'http://127.0.0.1:1', apiKey: 'secret' });
  check('test closed port -> unreachable', !r.ok && r.reason === 'unreachable', r);
  r = await api.radarrTest({ url: 'nonsense://', apiKey: 'secret' });
  check('test bad url -> bad_url', !r.ok && r.reason === 'bad_url', r);

  console.log('plexResolve (no token)');
  local = {};
  r = await api.plexResolve(inception);
  check('no token -> search link', r.type === 'search' && r.url.includes('Inception%202010'), r);

  console.log('settings page');
  const route = (msg) => new Promise((resolve) => listeners.message[0](msg, {}, resolve));
  session = {};
  r = await route({ action: 'openOptions', section: 'radarr' });
  check('openOptions -> opens the options page', r.ok === true && calls.openOptions === 1, r);
  check('openOptions -> remembers the section to scroll to', session.optionsFocus && session.optionsFocus.section === 'radarr', session);
  session = {};
  r = await route({ action: 'openOptions' });
  check('openOptions without section leaves no focus request', r.ok === true && !('optionsFocus' in session), session);
  listeners.actionClicked[0]();
  await waitFor(async () => calls.openOptions === 3);
  check('toolbar click -> opens the options page', calls.openOptions === 3, calls.openOptions);
  r = await route({ action: 'nope' });
  check('unknown action -> error', typeof r.error === 'string' && r.error.includes('nope'), r);

  console.log(`\n${pass} passed, ${fail} failed`);
  plexServer.close();
  radarrServer.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
