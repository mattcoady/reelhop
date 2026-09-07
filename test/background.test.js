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
const listeners = { storage: [], windowsRemoved: [], tabsRemoved: [], message: [], actionClicked: [], installed: [] };

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
    onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
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

const ctx = { chrome, fetch: routedFetch, AbortController, setTimeout, clearTimeout, console, crypto, URL, URLSearchParams, encodeURIComponent, JSON, Math, Promise, Date, Set, Map };
// The worker is a classic service worker, so shared.js arrives via
// importScripts. Do the same here rather than pre-loading it, so a broken
// import shows up as a test failure.
ctx.importScripts = (...files) => {
  for (const f of files) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx, { filename: f });
  }
};
vm.createContext(ctx);
vm.runInContext(src + '\n;globalThis.__api = { radarrResolve, radarrAdd, radarrTest, plexResolve, normalizeRadarrUrl, radarrOriginPattern, plexSignInStart, plexSignInStatus, plexSignInCancel, plexSignOut, getPlexHeaders, radarrHasFile, plexLibraryMatch, getLibraryIndex, radarrLibraryMatch, plexIndexStatus, plexIndexRebuild, sweepExpiredCache, sonarrResolve, sonarrAdd, sonarrLibraryMatch, sonarrTest };', ctx);
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
    // The connection's uri points at the fake PMS below; `protocol` is what
    // the worker filters on, so it says https even though the stub is plain HTTP.
    return send(200, [
      { name: 'Mattflix', clientIdentifier: 'mach-1', provides: 'server', accessToken: 'srv-tok',
        connections: [{ uri: pmsBase, protocol: 'https', local: true, relay: false }] },
      { name: 'Living Room TV', provides: 'player', connections: [] }
    ]);
  }
  send(404, {});
});

// ---- fake Sonarr -----------------------------------------------------------
// Same shape as the Radarr stub, in Sonarr's nouns: /series, tvdbId, and
// statistics instead of a single file.
const seriesCatalog = {
  'tt2861424': { tvdbId: 275274, title: 'Rick and Morty', year: 2013, titleSlug: 'rick-and-morty', imdbId: 'tt2861424' },
  'tt11280740': { tvdbId: 371980, title: 'Severance', year: 2022, titleSlug: 'severance', imdbId: 'tt11280740' }
};
const seriesLibrary = new Map();
let sonarrApp = 'Sonarr';
let sonarrPost = null;
const sonarr = { listCalls: 0, postCount: 0 };
const sonarrServer = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.headers['x-api-key'] !== 'sonarr-key') return send(401, { error: 'Unauthorized' });
  if (u.pathname === '/api/v3/system/status') return send(200, { appName: sonarrApp, instanceName: 'Sonarr (NAS)', version: '4.0.9.2244' });
  if (u.pathname === '/api/v3/qualityprofile') return send(200, [{ id: 2, name: 'HD-1080p' }]);
  if (u.pathname === '/api/v3/rootfolder') return send(200, [{ id: 1, path: '/tv', freeSpace: 512000000000 }]);
  if (u.pathname === '/api/v3/series/lookup') {
    const term = u.searchParams.get('term') || '';
    let results = [];
    if (term.startsWith('imdb:')) { const x = seriesCatalog[term.slice(5)]; if (x) results = [x]; }
    else results = Object.values(seriesCatalog).filter(x => term.toLowerCase().includes(x.title.toLowerCase()));
    return send(200, results.map(x => ({ ...x, id: 0 })));
  }
  if (u.pathname === '/api/v3/series' && req.method === 'GET') {
    if (!u.searchParams.has('tvdbId')) {
      sonarr.listCalls++;
      return send(200, [...seriesLibrary.values()]);
    }
    const x = seriesLibrary.get(Number(u.searchParams.get('tvdbId')));
    return send(200, x ? [x] : []);
  }
  if (u.pathname === '/api/v3/series' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      sonarr.postCount++;
      const x = JSON.parse(body); sonarrPost = x;
      if (seriesLibrary.has(x.tvdbId)) return send(400, [{ errorMessage: 'This series has already been added' }]);
      const added = { ...x, id: 500 + seriesLibrary.size, statistics: { episodeCount: 10, episodeFileCount: 0 } };
      seriesLibrary.set(x.tvdbId, added);
      send(201, added);
    });
    return;
  }
  send(404, {});
});

// ---- fake Plex Media Server ------------------------------------------------
// Two video sections plus a music one (which must be skipped), listed by the
// library index behind the poster badges.
let pmsBase = '';
const pms = { sectionCalls: 0, listCalls: 0, sectionsStatus: 200 };
const pmsSections = [
  { key: '1', type: 'movie', title: 'Movies' },
  { key: '2', type: 'show', title: 'TV Shows' },
  { key: '3', type: 'artist', title: 'Music' }
];
const pmsItems = {
  '1': [
    { ratingKey: '901', type: 'movie', title: 'Inception', year: 2010 },
    { ratingKey: '902', type: 'movie', title: 'Spider-Man: Into the Spider-Verse', year: 2018 },
    { ratingKey: '903', type: 'movie', title: 'PlayTime', originalTitle: 'Play Time', year: 1967 },
    { ratingKey: '904', type: 'movie', title: 'The Thing', year: 1982 },
    { ratingKey: '905', type: 'movie', title: 'The Thing', year: 2011 },
    { ratingKey: '906', type: 'movie', title: 'Dune: Part Two', year: 2023 } // Letterboxd says 2024
  ],
  '2': [{ ratingKey: '950', type: 'show', title: 'Severance', year: 2022 }],
  '3': [{ ratingKey: '990', type: 'track', title: 'Never Indexed', year: 1999 }]
};
const pmsServer = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.headers['x-plex-token'] !== 'srv-tok') return send(401, {});
  if (u.pathname === '/library/sections') {
    pms.sectionCalls++;
    if (pms.sectionsStatus !== 200) return send(pms.sectionsStatus, {});
    return send(200, { MediaContainer: { Directory: pmsSections } });
  }
  const m = u.pathname.match(/^\/library\/sections\/(\d+)\/all$/);
  if (m) {
    pms.listCalls++;
    return send(200, { MediaContainer: { Metadata: pmsItems[m[1]] || [] } });
  }
  if (u.pathname === '/hubs/search') return send(200, { MediaContainer: { Metadata: [] } });
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
const radarr = { listCalls: 0 };
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
    if (!u.searchParams.has('tmdbId')) {
      radarr.listCalls++;
      return send(200, [...library.values()]);
    }
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
  pmsBase = await listen(pmsServer);
  const base = await listen(radarrServer);
  const sonarrBase = await listen(sonarrServer);

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

  console.log('Plex library index (poster badges)');
  // A token change is the documented way to drop the index; it also resets the
  // worker's in-memory copy between cases here.
  const resetIndex = async (token) => {
    session = {};
    await chrome.storage.local.set({ plexToken: token });
    await sleep(5);
  };
  const ask = (films) => api.plexLibraryMatch(films.map(f => ({ key: f[0], title: f[1], year: f[2] })));

  local = {};
  session = {};
  r = await api.plexLibraryMatch([{ key: 'inception', title: 'Inception', year: '2010' }]);
  check('no token -> no_token', r.ok === false && r.reason === 'no_token', r);

  await resetIndex('tok-123');
  pms.sectionCalls = 0; pms.listCalls = 0;
  r = await ask([
    ['inception', 'Inception', '2010'],
    ['spider-man-into-the-spider-verse', 'Spider-Man: Into the Spider-Verse', '2018'],
    ['severance', 'Severance', '2022'],
    ['the-holdovers', 'The Holdovers', '2023']
  ]);
  check('indexes every video section once, skipping music', pms.sectionCalls === 1 && pms.listCalls === 2, pms);
  check('exact title + year -> server deep link', r.ok && r.matches.inception &&
    r.matches.inception.url.includes('mach-1') && r.matches.inception.url.includes('901') &&
    r.matches.inception.serverName === 'Mattflix', r.matches);
  check('punctuation and case are ignored', !!r.matches['spider-man-into-the-spider-verse'], r.matches);
  check('TV shows are indexed too', r.matches.severance && r.matches.severance.ratingKey === '950', r.matches);
  check('a title that is not on the server has no match', !('the-holdovers' in r.matches), r.matches);
  check('report counts what was indexed', r.indexed === 7 && r.servers === 1, r);

  pms.sectionCalls = 0; pms.listCalls = 0;
  r = await ask([['playtime', 'Play Time', '1967'], ['dune-part-two', 'Dune: Part Two', '2024']]);
  check('second batch reuses the index (no refetch)', pms.sectionCalls === 0 && pms.listCalls === 0, pms);
  check('original title matches', r.matches.playtime && r.matches.playtime.ratingKey === '903', r.matches);
  check('a year one off still matches', r.matches['dune-part-two'] && r.matches['dune-part-two'].ratingKey === '906', r.matches);

  r = await ask([['the-thing', 'The Thing', '1982'], ['the-thing-2011', 'The Thing', '2011']]);
  check('same title, different years -> each takes its own year', r.matches['the-thing'].ratingKey === '904' &&
    r.matches['the-thing-2011'].ratingKey === '905', r.matches);
  r = await ask([['the-thing', 'The Thing', ''], ['inception', 'Inception', '']]);
  check('no year + ambiguous title -> no guess', !('the-thing' in r.matches), r.matches);
  check('no year + one candidate -> matched', !!r.matches.inception, r.matches);
  r = await ask([['x', '', '1982'], ['never-indexed', 'Never Indexed', '1999']]);
  check('empty title and music tracks never match', Object.keys(r.matches).length === 0, r.matches);

  // The index survives the worker sleeping: it is rebuilt from session storage.
  check('index is kept in session storage', !!(session.libraryIndex && session.libraryIndex.entries.length === 7), Object.keys(session));

  await resetIndex('tok-123');
  check('a token change drops the stored index', !session.libraryIndex, session);
  pms.sectionsStatus = 500;
  await resetIndex('tok-123');
  r = await ask([['inception', 'Inception', '2010']]);
  check('server unreachable -> reported, not cached as empty', r.ok === false && r.reason === 'unreachable' && !session.libraryIndex, r);
  pms.sectionsStatus = 200;
  await resetIndex('tok-123');
  pms.sectionCalls = 0;
  const both = await Promise.all([ask([['inception', 'Inception', '2010']]), ask([['severance', 'Severance', '2022']])]);
  check('concurrent tabs share one build', pms.sectionCalls === 1 && both[0].ok && both[1].ok, pms);

  console.log('Plex index status (settings page)');
  local = {};
  session = {};
  r = await api.plexIndexStatus();
  check('signed out -> needs sign-in', r.status === 'no_token', r);

  await chrome.storage.local.set({ plexToken: 'tok-123' });
  await sleep(5);
  r = await api.plexIndexStatus();
  check('signed in, never indexed -> not built', r.status === 'none', r);

  pms.sectionCalls = 0;
  r = await api.plexIndexRebuild();
  check('build on demand -> ready with counts', r.status === 'ready' && r.entries === 7 && r.servers === 1 && pms.sectionCalls === 1, r);
  check('build publishes its state for the settings page', session.libraryIndexState &&
    session.libraryIndexState.status === 'ready' && session.libraryIndexState.entries === 7, session.libraryIndexState);
  r = await api.plexIndexStatus();
  check('status reports the stored index', r.status === 'ready' && r.entries === 7 && r.stale === false, r);

  pms.sectionCalls = 0;
  r = await api.plexIndexRebuild();
  check('rebuild re-reads the server', pms.sectionCalls === 1 && r.status === 'ready', r);

  pms.sectionsStatus = 500;
  r = await api.plexIndexRebuild();
  check('nothing reachable -> unreachable, not "ready"', r.status === 'unreachable', r);
  pms.sectionsStatus = 200;
  await chrome.storage.local.set({ plexToken: 'tok-123' });
  await sleep(5);
  check('a token change clears the published state', !session.libraryIndexState, session);

  console.log('Radarr library index (poster + buttons)');
  const radarrAsk = (films) => api.radarrLibraryMatch(films.map(f => ({ key: f[0], title: f[1], year: f[2] })));
  // Changing any radarr* setting drops the index, which is how these cases
  // start from a clean slate.
  const resetRadarrIndex = async () => { await chrome.storage.local.set({ radarrUrl: base }); await sleep(5); };

  local = {};
  r = await radarrAsk([['inception', 'Inception', '2010']]);
  check('radarr off -> disabled', r.ok === false && r.reason === 'disabled', r);

  cfg({ radarrEnabled: true, radarrUrl: base, radarrApiKey: 'secret', radarrQualityProfileId: 4, radarrRootFolder: '/movies' });
  library.clear();
  library.set(278, { id: 42, ...catalog['tt0111161'], movieFileId: 12, movieFile: { id: 12 }, monitored: true });
  library.set(27205, { id: 43, ...catalog['tt1375666'], movieFileId: 0, movieFile: null, monitored: true });
  await resetRadarrIndex();
  radarr.listCalls = 0;
  r = await radarrAsk([
    ['the-shawshank-redemption', 'The Shawshank Redemption', '1994'],
    ['inception', 'Inception', '2010'],
    ['the-holdovers', 'The Holdovers', '2023']
  ]);
  check('lists the library once for the whole batch', radarr.listCalls === 1, radarr);
  check('a downloaded movie reports its file', r.ok && r.matches['the-shawshank-redemption'] &&
    r.matches['the-shawshank-redemption'].hasFile === true, r.matches);
  check('a wanted movie reports no file', r.matches.inception && r.matches.inception.hasFile === false &&
    r.matches.inception.monitored === true, r.matches);
  check('a movie link points at the Radarr page', (r.matches.inception.url || '').includes('/movie/27205'), r.matches);
  check('a film that is not in Radarr is absent', !('the-holdovers' in r.matches), r.matches);
  check('reports whether a one-click add is possible', r.canAdd === true && r.addUrlBase.includes('/add/new?term='), r);

  radarr.listCalls = 0;
  r = await radarrAsk([['inception', 'Inception', '2010']]);
  check('second batch reuses the index', radarr.listCalls === 0, radarr);

  cfg({ radarrEnabled: true, radarrUrl: base, radarrApiKey: 'secret', radarrQualityProfileId: 0, radarrRootFolder: '' });
  await resetRadarrIndex();
  r = await radarrAsk([['inception', 'Inception', '2010']]);
  check('no profile or root folder -> canAdd false', r.ok && r.canAdd === false, r);

  cfg({ radarrEnabled: true, radarrUrl: base, radarrApiKey: 'nope', radarrQualityProfileId: 4, radarrRootFolder: '/movies' });
  await resetRadarrIndex();
  r = await radarrAsk([['inception', 'Inception', '2010']]);
  check('bad api key -> unauthorized, nothing cached', r.ok === false && r.reason === 'unauthorized' && !session.radarrIndex, r);

  // Adding from a poster: title and year only, no IMDb or TMDB id.
  cfg({ radarrEnabled: true, radarrUrl: base, radarrApiKey: 'secret', radarrQualityProfileId: 4, radarrRootFolder: '/movies' });
  library.delete(27205);
  await resetRadarrIndex();
  await radarrAsk([['inception', 'Inception', '2010']]);
  check('index is stored for the session', !!session.radarrIndex, Object.keys(session));
  postCount = 0;
  r = await api.radarrAdd({ title: 'Inception', year: '2010' });
  check('add by title alone -> in_library', r.status === 'in_library' && r.justAdded === true && postCount === 1, r);
  check('adding drops the stale index', !session.radarrIndex, Object.keys(session));
  radarr.listCalls = 0;
  r = await radarrAsk([['inception', 'Inception', '2010']]);
  check('the rebuilt index sees the new movie', radarr.listCalls === 1 && !!r.matches.inception, r.matches);

  console.log('Sonarr');
  const sonarrCfg = (extra) => { local = { sonarrEnabled: true, sonarrUrl: sonarrBase, sonarrApiKey: 'sonarr-key', ...extra }; };
  const severance = { title: 'Severance', year: '2022', imdbId: 'tt11280740', type: 'show' };
  const rickMorty = { title: 'Rick and Morty', year: '2013', imdbId: 'tt2861424', type: 'show' };

  local = {};
  r = await api.sonarrResolve(severance);
  check('sonarr off -> disabled', r.status === 'disabled', r);

  sonarrCfg({ sonarrApiKey: '' });
  r = await api.sonarrResolve(severance);
  check('no api key -> unconfigured', r.status === 'unconfigured', r);

  seriesLibrary.clear();
  sonarrCfg({ sonarrQualityProfileId: 2, sonarrRootFolder: '/tv' });
  r = await api.sonarrResolve(severance);
  check('a series not in Sonarr -> missing, addable', r.status === 'missing' && r.canAdd === true, r);
  check('and points at Sonarr\'s add page', (r.url || '').includes('/add/new?term=imdb%3Att11280740'), r);

  sonarr.postCount = 0;
  r = await api.sonarrAdd(severance);
  check('add -> in_library', r.status === 'in_library' && r.justAdded === true && sonarr.postCount === 1, r);
  check('POST carries the profile, root folder and monitor choice',
    sonarrPost.qualityProfileId === 2 && sonarrPost.rootFolderPath === '/tv' &&
    sonarrPost.addOptions.monitor === 'all' && sonarrPost.addOptions.searchForMissingEpisodes === true &&
    sonarrPost.seasonFolder === true, sonarrPost);
  check('a freshly added series has no episodes yet', r.hasFile === false && r.partial === false, r);

  r = await api.sonarrResolve(severance);
  check('now it is in the library', r.status === 'in_library' && r.alreadyAdded !== true, r);
  check('and links to its Sonarr page', (r.url || '').includes('/series/severance'), r);

  // Sonarr counts episodes, so a series can be partly here.
  seriesLibrary.get(371980).statistics = { episodeCount: 10, episodeFileCount: 4 };
  r = await api.sonarrResolve(severance);
  check('4 of 10 episodes -> partial, not downloaded', r.partial === true && r.hasFile === false &&
    r.episodeFileCount === 4 && r.episodeCount === 10, r);
  seriesLibrary.get(371980).statistics = { episodeCount: 10, episodeFileCount: 10 };
  r = await api.sonarrResolve(severance);
  check('every episode -> downloaded', r.hasFile === true && r.partial === false, r);

  sonarr.postCount = 0;
  r = await api.sonarrAdd(severance);
  check('adding an existing series reports it without posting', r.alreadyAdded === true && sonarr.postCount === 0, r);

  sonarrCfg({ sonarrQualityProfileId: 0, sonarrRootFolder: '' });
  r = await api.sonarrAdd(rickMorty);
  check('no profile or root folder -> unconfigured, nothing posted', r.status === 'unconfigured', r);

  console.log('Sonarr library index');
  sonarrCfg({ sonarrQualityProfileId: 2, sonarrRootFolder: '/tv' });
  await chrome.storage.local.set({ sonarrUrl: sonarrBase });
  await sleep(5);
  sonarr.listCalls = 0;
  r = await api.sonarrLibraryMatch([
    { key: 'severance', title: 'Severance', year: '2022' },
    { key: 'rick-and-morty', title: 'Rick and Morty', year: '2013' }
  ]);
  check('lists the library once for the batch', sonarr.listCalls === 1, sonarr);
  check('a series in Sonarr is matched', !!r.matches.severance && r.matches.severance.hasFile === true, r.matches);
  check('one that is not is absent', !('rick-and-morty' in r.matches), r.matches);
  check('reports whether a one-click add is possible', r.ok && r.canAdd === true, r);

  console.log('sonarrTest');
  r = await api.sonarrTest({ url: sonarrBase, apiKey: 'sonarr-key' });
  check('connect ok + options', r.ok && r.profiles[0].name === 'HD-1080p' && r.rootFolders[0].path === '/tv' &&
    r.instanceName === 'Sonarr (NAS)', r);
  r = await api.sonarrTest({ url: sonarrBase, apiKey: 'nope' });
  check('bad key -> unauthorized', !r.ok && r.reason === 'unauthorized', r);
  sonarrApp = 'Radarr';
  r = await api.sonarrTest({ url: sonarrBase, apiKey: 'sonarr-key' });
  check('pointing at Radarr -> wrong_app', !r.ok && r.reason === 'wrong_app' && r.appName === 'Radarr', r);
  sonarrApp = 'Sonarr';

  console.log('first run');
  local = {};
  session = {};
  calls.openOptions = 0;
  await listeners.installed[0]({ reason: 'update', previousVersion: '2.6.0' });
  check('an update opens nothing', calls.openOptions === 0 && !local.installedAt, { calls: calls.openOptions, local });
  await listeners.installed[0]({ reason: 'install' });
  await waitFor(async () => calls.openOptions === 1);
  check('a fresh install opens the settings page', calls.openOptions === 1, calls.openOptions);
  check('and lands on the Plex card', session.optionsFocus && session.optionsFocus.section === 'plex', session);
  check('the install is recorded', typeof local.installedAt === 'number', local);

  console.log('film-link cache upkeep');
  const day = 24 * 60 * 60 * 1000;
  local = {
    cacheTarget_letterboxd_fresh: { url: 'a', timestamp: Date.now() - day },
    cacheTarget_letterboxd_old: { url: 'b', timestamp: Date.now() - 8 * day },
    cacheTarget_imdb_ancient: { url: 'c', timestamp: Date.now() - 400 * day },
    cacheTarget_letterboxd_broken: { url: 'd' },
    plexToken: 'tok-123'
  };
  const swept = await api.sweepExpiredCache();
  check('sweep removes only the expired entries', swept === 3 &&
    'cacheTarget_letterboxd_fresh' in local && !('cacheTarget_letterboxd_old' in local) &&
    !('cacheTarget_imdb_ancient' in local) && !('cacheTarget_letterboxd_broken' in local), Object.keys(local));
  check('sweep leaves settings alone', local.plexToken === 'tok-123', local);
  check('sweep on an empty store is a no-op', await api.sweepExpiredCache() === 0);

  console.log('settings page');
  const route = (msg) => new Promise((resolve) => listeners.message[0](msg, {}, resolve));
  session = {};
  // Counted relative to here, so the order of the blocks above can change.
  let opened = calls.openOptions;
  r = await route({ action: 'openOptions', section: 'radarr' });
  check('openOptions -> opens the options page', r.ok === true && calls.openOptions === opened + 1, r);
  check('openOptions -> remembers the section to scroll to', session.optionsFocus && session.optionsFocus.section === 'radarr', session);
  session = {};
  r = await route({ action: 'openOptions' });
  check('openOptions without section leaves no focus request', r.ok === true && !('optionsFocus' in session), session);
  opened = calls.openOptions;
  listeners.actionClicked[0]();
  await waitFor(async () => calls.openOptions === opened + 1);
  check('toolbar click -> opens the options page', calls.openOptions === opened + 1, calls.openOptions);
  r = await route({ action: 'nope' });
  check('unknown action -> error', typeof r.error === 'string' && r.error.includes('nope'), r);

  console.log(`\n${pass} passed, ${fail} failed`);
  plexServer.close();
  pmsServer.close();
  radarrServer.close();
  sonarrServer.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
