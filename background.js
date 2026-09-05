// ReelHop - Background Service Worker
//
// Every network call happens here (never in content scripts), so the
// extension only needs narrow host permissions: Plex's own domains, plus the
// single Radarr origin the user grants at runtime from the popup.
//
// Destinations each get their own section and their own message actions
// (plexResolve, radarrResolve, radarrAdd, ...). The content script asks for
// every enabled destination in parallel and paints whatever comes back, so a
// slow or offline Radarr never delays the Plex link.

const SERVER_LIST_TTL = 3600000; // 1 hour
const REQUEST_TIMEOUT = 3000;

function sanitizeText(str) {
  if (!str) return '';
  return str
    .replace(/[\u00A0\u1680\u180e\u2000-\u200b\u202f\u205f\u3000\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalize(str) {
  return sanitizeText(str)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function yearsClose(a, b) {
  const ya = parseInt(a, 10);
  const yb = parseInt(b, 10);
  return !ya || !yb || Math.abs(ya - yb) <= 1;
}

function fetchWithTimeout(url, options = {}, timeout = REQUEST_TIMEOUT) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timeoutId));
}

// ===========================================================================
// Plex
// ===========================================================================

async function getClientId() {
  const { clientId } = await chrome.storage.local.get('clientId');
  if (clientId) return clientId;
  const newId = 'reelhop-' + (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 15));
  await chrome.storage.local.set({ clientId: newId });
  return newId;
}

async function getPlexHeaders(token) {
  return {
    'Accept': 'application/json',
    'X-Plex-Token': token,
    'X-Plex-Client-Identifier': await getClientId(),
    'X-Plex-Product': 'ReelHop',
    'X-Plex-Version': chrome.runtime.getManifest().version,
    'X-Plex-Platform': 'Browser',
    'X-Plex-Device': 'Desktop',
    'X-Plex-Device-Name': 'ReelHop'
  };
}

function getSearchUrl(title, year) {
  const q = year ? `${sanitizeText(title)} ${sanitizeText(year)}` : sanitizeText(title);
  return `https://app.plex.tv/desktop/#!/search?query=${encodeURIComponent(q)}`;
}

function getDiscoverUrl(ratingKey) {
  return `https://app.plex.tv/desktop/#!/provider/tv.plex.provider.discover/details?key=%2Flibrary%2Fmetadata%2F${encodeURIComponent(ratingKey)}`;
}

function getServerUrl(machineIdentifier, ratingKey) {
  return `https://app.plex.tv/desktop/#!/server/${encodeURIComponent(machineIdentifier)}/details?key=%2Flibrary%2Fmetadata%2F${encodeURIComponent(ratingKey)}`;
}

// 1. Fetch the user's server list from plex.tv (cached in session storage)
async function getUserServers(token) {
  try {
    const { serverCache } = await chrome.storage.session.get('serverCache');
    if (serverCache && Date.now() - serverCache.timestamp < SERVER_LIST_TTL) {
      return serverCache.servers;
    }
  } catch (e) {
    // storage.session unavailable; fall through to a live fetch
  }

  try {
    const res = await fetchWithTimeout('https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=1', {
      headers: await getPlexHeaders(token)
    }, 8000);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) {
        const servers = data.filter(d => d.provides && d.provides.includes('server') && Array.isArray(d.connections));
        try {
          await chrome.storage.session.set({ serverCache: { servers, timestamp: Date.now() } });
        } catch (e) { /* non-fatal */ }
        return servers;
      }
    }
  } catch (e) {
    console.warn('[ReelHop] Error fetching user servers:', e);
  }
  return [];
}

// 2. Search the user's personal servers for the movie or show
async function searchUserServers(title, year, token, imdbId, mediaType) {
  const servers = await getUserServers(token);
  if (!servers || servers.length === 0) return null;

  const cleanTitle = sanitizeText(title);
  const normTargetTitle = normalize(cleanTitle);
  // Which Plex item types are acceptable. mediaType is a soft hint ('movie'
  // | 'show' | '' unknown); IMDb-ID matches are always accepted regardless.
  const allowedTypes = mediaType === 'show' ? ['show']
    : mediaType === 'movie' ? ['movie']
    : ['movie', 'show'];

  for (const server of servers) {
    const serverToken = server.accessToken || token;
    // Only secure connections; the token travels in a header, never the URL.
    const connections = server.connections
      .filter(c => c.uri && c.protocol === 'https')
      .sort((a, b) => {
        if (a.local && !b.local) return -1;
        if (!a.local && b.local) return 1;
        if (a.relay && !b.relay) return 1;
        if (!a.relay && b.relay) return -1;
        return 0;
      });

    for (const conn of connections) {
      try {
        const searchUrl = `${conn.uri}/hubs/search?query=${encodeURIComponent(cleanTitle)}&limit=10`;
        const response = await fetchWithTimeout(searchUrl, {
          headers: {
            'Accept': 'application/json',
            'X-Plex-Token': serverToken
          }
        });

        if (!response.ok) continue;

        const data = await response.json();
        const items = [];

        if (Array.isArray(data.MediaContainer?.Metadata)) {
          items.push(...data.MediaContainer.Metadata);
        }
        if (Array.isArray(data.MediaContainer?.Hub)) {
          for (const hub of data.MediaContainer.Hub) {
            if ((hub.type === 'movie' || hub.type === 'show') && Array.isArray(hub.Metadata)) {
              items.push(...hub.Metadata);
            }
          }
        }

        for (const item of items) {
          if (item.type !== 'movie' && item.type !== 'show') continue;

          const imdbMatch = imdbId && (
            (item.guid && item.guid.includes(imdbId)) ||
            (Array.isArray(item.Guid) && item.Guid.some(g => g.id && g.id.includes(imdbId)))
          );

          // Title fallback must be the right kind of item (when we know it),
          // so a same-named movie can't shadow the show we're after.
          const titleMatch = allowedTypes.includes(item.type) &&
            normalize(item.title || '') === normTargetTitle &&
            yearsClose(item.year, year);

          if (imdbMatch || titleMatch) {
            return {
              type: 'server',
              machineIdentifier: server.clientIdentifier,
              serverName: server.name,
              ratingKey: item.ratingKey,
              url: getServerUrl(server.clientIdentifier, item.ratingKey)
            };
          }
        }

        // This connection worked but had no match; no need to try the
        // server's other connections.
        break;
      } catch (err) {
        // Connection unreachable or blocked; try the next one.
      }
    }
  }

  return null;
}

// 3. Search the Discover API for the movie or show
async function fetchPlexDiscoverRatingKey(title, year, token, imdbId, mediaType) {
  const cleanTitle = sanitizeText(title);
  const normTargetTitle = normalize(cleanTitle);
  const headers = await getPlexHeaders(token);

  // Plex Discover types: 1 = movie, 2 = show. When we don't know, try both.
  const matchTypes = mediaType === 'show' ? [2]
    : mediaType === 'movie' ? [1]
    : [1, 2];
  const matchUrl = (t) =>
    `https://discover.provider.plex.tv/library/metadata/matches?manual=1&title=${encodeURIComponent(cleanTitle)}&year=${encodeURIComponent(year || '')}&type=${t}`;

  const candidateUrls = [
    ...matchTypes.map(matchUrl),
    `https://discover.provider.plex.tv/library/search?query=${encodeURIComponent(cleanTitle)}&limit=10`
  ];

  for (const url of candidateUrls) {
    try {
      const response = await fetchWithTimeout(url, { headers }, 8000);
      if (!response.ok) continue;

      const data = await response.json();
      const items = [];

      if (Array.isArray(data.MediaContainer?.Metadata)) {
        items.push(...data.MediaContainer.Metadata);
      }
      if (Array.isArray(data.MediaContainer?.SearchResult)) {
        items.push(...data.MediaContainer.SearchResult);
      }

      if (items.length === 0) continue;

      if (imdbId) {
        for (const item of items) {
          if (item.guid && item.guid.includes(imdbId)) {
            return item.ratingKey || item.id;
          }
          if (Array.isArray(item.Guid) && item.Guid.some(g => g.id && g.id.includes(imdbId))) {
            return item.ratingKey || item.id;
          }
        }
      }

      for (const item of items) {
        if (normalize(item.title || '') === normTargetTitle && yearsClose(item.year, year)) {
          return item.ratingKey || item.id;
        }
      }
      // No confident match in this response; deliberately no first-item
      // fallback — a wrong deep link is worse than falling back to search.
    } catch (e) {
      console.warn('[ReelHop] Discover fetch failed:', e);
    }
  }

  return null;
}

async function plexResolve(movie) {
  const settings = await chrome.storage.local.get(['plexToken', 'preferredMode']);
  const plexToken = settings.plexToken || '';
  const preferredMode = settings.preferredMode || 'server_first';

  if (plexToken && preferredMode !== 'discover_only' && preferredMode !== 'search_only') {
    const serverMatch = await searchUserServers(movie.title, movie.year, plexToken, movie.imdbId, movie.type);
    if (serverMatch) return serverMatch;
    if (preferredMode === 'server_only') {
      return { type: 'search', url: getSearchUrl(movie.title, movie.year) };
    }
  }

  if (plexToken && preferredMode !== 'search_only') {
    const discoverKey = await fetchPlexDiscoverRatingKey(movie.title, movie.year, plexToken, movie.imdbId, movie.type);
    if (discoverKey) {
      return {
        type: 'discover',
        ratingKey: discoverKey,
        url: getDiscoverUrl(discoverKey)
      };
    }
  }

  return {
    type: 'search',
    url: getSearchUrl(movie.title, movie.year)
  };
}

async function plexTest(token) {
  const headers = await getPlexHeaders(token);

  const userRes = await fetchWithTimeout('https://plex.tv/api/v2/user', { headers }, 8000);
  if (userRes.status === 401) {
    return { ok: false, reason: 'unauthorized' };
  }

  let username = '';
  if (userRes.ok) {
    const userData = await userRes.json();
    username = userData.username || userData.email || '';
  }

  let serverNames = [];
  try {
    const resRes = await fetchWithTimeout('https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=1', { headers }, 8000);
    if (resRes.ok) {
      const resources = await resRes.json();
      if (Array.isArray(resources)) {
        serverNames = resources
          .filter(r => r.provides && r.provides.includes('server'))
          .map(s => s.name);
      }
    }
  } catch (err) {
    console.warn('[ReelHop] Resources fetch error:', err);
  }

  return { ok: true, username, serverNames };
}

// ===========================================================================
// Radarr
//
// Radarr is movies-only, so the content script never asks about TV shows.
// The user's Radarr lives at an arbitrary URL (often plain-HTTP on a LAN), so
// its origin is an optional host permission the popup requests when they
// save the URL; without it every call short-circuits to status 'permission'.
// ===========================================================================

const RADARR_TIMEOUT = 8000;

class RadarrHttpError extends Error {
  constructor(status) {
    super(`Radarr returned HTTP ${status}`);
    this.status = status;
  }
}

// Turn whatever the user typed into "http(s)://host[:port][/urlbase]" with no
// trailing slash. Returns '' when it can't be a valid http(s) URL.
function normalizeRadarrUrl(raw) {
  let s = (raw || '').trim();
  if (!s) return '';
  // Anything with a non-http(s) scheme is a typo, not a Radarr address.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^https?:\/\//i.test(s)) return '';
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return (u.origin + u.pathname).replace(/\/+$/, '');
  } catch (e) {
    return '';
  }
}

// Match pattern for the Radarr host. Chrome match patterns cover every port
// unless one is written explicitly, so this works for :7878 and friends.
function radarrOriginPattern(baseUrl) {
  const u = new URL(baseUrl);
  return `${u.protocol}//${u.hostname}/*`;
}

async function getRadarrConfig() {
  const items = await chrome.storage.local.get([
    'radarrEnabled', 'radarrUrl', 'radarrApiKey', 'radarrQualityProfileId',
    'radarrRootFolder', 'radarrMinAvailability', 'radarrSearchOnAdd'
  ]);
  const url = normalizeRadarrUrl(items.radarrUrl);
  const apiKey = (items.radarrApiKey || '').trim();
  return {
    enabled: items.radarrEnabled === true && !!url,
    url,
    apiKey,
    qualityProfileId: parseInt(items.radarrQualityProfileId, 10) || 0,
    rootFolder: items.radarrRootFolder || '',
    minAvailability: items.radarrMinAvailability || 'released',
    searchOnAdd: items.radarrSearchOnAdd !== false
  };
}

async function hasRadarrPermission(url) {
  try {
    return await chrome.permissions.contains({ origins: [radarrOriginPattern(url)] });
  } catch (e) {
    return false;
  }
}

function radarrFetch(cfg, path, options = {}, timeout = RADARR_TIMEOUT) {
  const headers = {
    'Accept': 'application/json',
    'X-Api-Key': cfg.apiKey
  };
  if (options.body) headers['Content-Type'] = 'application/json';
  return fetchWithTimeout(`${cfg.url}/api/v3${path}`, { ...options, headers }, timeout);
}

function radarrMovieUrl(cfg, movie) {
  const slug = (movie && (movie.titleSlug || movie.tmdbId)) ? String(movie.titleSlug || movie.tmdbId) : '';
  return slug ? `${cfg.url}/movie/${encodeURIComponent(slug)}` : cfg.url;
}

function radarrAddPageUrl(cfg, term) {
  return `${cfg.url}/add/new?term=${encodeURIComponent(term)}`;
}

function radarrSearchTerm(movie) {
  return sanitizeText(movie.year ? `${movie.title} ${movie.year}` : movie.title);
}

// Every Radarr answer has the same shape so the content script can paint it.
function radarrResult(status, movie, extra = {}) {
  const out = { destination: 'radarr', status, ...extra };
  if (movie) {
    out.title = movie.title || '';
    out.year = movie.year || 0;
    out.tmdbId = movie.tmdbId || 0;
    out.titleSlug = movie.titleSlug || '';
    out.radarrId = movie.id || 0;
    out.hasFile = !!movie.hasFile;
    out.monitored = !!movie.monitored;
  }
  return out;
}

function radarrFailure(cfg, e) {
  if (e instanceof RadarrHttpError) {
    if (e.status === 401) return radarrResult('unauthorized', null, { url: cfg.url });
    return radarrResult('error', null, { url: cfg.url, message: e.message });
  }
  return radarrResult('unreachable', null, { url: cfg.url, message: (e && e.message) || 'Could not reach Radarr' });
}

// Find the movie in Radarr. Prefers an IMDb-ID lookup, then TMDB ID, then a
// title search matched on normalized title + year (±1). Resolves to
// { status: 'in_library' | 'missing' | 'not_found', movie } where `movie` is
// Radarr's MovieResource: the library copy when it exists, otherwise the
// lookup result (which is exactly what POST /movie wants back).
async function radarrLookup(movie, cfg) {
  let term;
  if (movie.imdbId) term = `imdb:${movie.imdbId}`;
  else if (movie.tmdbId) term = `tmdb:${movie.tmdbId}`;
  else term = radarrSearchTerm(movie);

  const res = await radarrFetch(cfg, `/movie/lookup?term=${encodeURIComponent(term)}`);
  if (!res.ok) throw new RadarrHttpError(res.status);
  const data = await res.json();
  const results = Array.isArray(data) ? data : [];

  let match = null;
  if (movie.imdbId || movie.tmdbId) {
    match = results[0] || null; // ID lookups are exact: zero or one result
  } else {
    const wantTitle = normalize(movie.title);
    match = results.find(m => normalize(m.title || '') === wantTitle && yearsClose(m.year, movie.year)) || null;
  }
  if (!match) return { status: 'not_found', movie: null };
  if (match.id > 0) return { status: 'in_library', movie: match };

  // Lookup results only sometimes carry the library id; GET /movie?tmdbId=
  // is the authoritative "is this already in my library" check.
  if (match.tmdbId) {
    const check = await radarrFetch(cfg, `/movie?tmdbId=${encodeURIComponent(match.tmdbId)}`);
    if (check.ok) {
      const existing = await check.json();
      if (Array.isArray(existing) && existing.length > 0) {
        return { status: 'in_library', movie: existing[0] };
      }
    }
  }
  return { status: 'missing', movie: match };
}

async function radarrResolve(movie) {
  const cfg = await getRadarrConfig();
  if (!cfg.enabled) return radarrResult('disabled');
  if (!cfg.apiKey) return radarrResult('unconfigured', null, { url: cfg.url, message: 'Add your Radarr API key in ReelHop settings.' });
  if (!(await hasRadarrPermission(cfg.url))) return radarrResult('permission', null, { url: cfg.url });

  const canAdd = cfg.qualityProfileId > 0 && !!cfg.rootFolder;
  try {
    const found = await radarrLookup(movie, cfg);
    if (found.status === 'in_library') {
      return radarrResult('in_library', found.movie, { url: radarrMovieUrl(cfg, found.movie) });
    }
    if (found.status === 'missing') {
      const term = movie.imdbId ? `imdb:${movie.imdbId}` : radarrSearchTerm(movie);
      return radarrResult('missing', found.movie, { url: radarrAddPageUrl(cfg, term), canAdd });
    }
    return radarrResult('not_found', null, { url: radarrAddPageUrl(cfg, radarrSearchTerm(movie)) });
  } catch (e) {
    return radarrFailure(cfg, e);
  }
}

// One-click add: re-check the library (the page may be stale), then POST the
// lookup result back with the user's profile / root folder / availability.
async function radarrAdd(movie) {
  const cfg = await getRadarrConfig();
  if (!cfg.enabled) return radarrResult('disabled');
  if (!cfg.apiKey) return radarrResult('unconfigured', null, { url: cfg.url, message: 'Add your Radarr API key in ReelHop settings.' });
  if (!(await hasRadarrPermission(cfg.url))) return radarrResult('permission', null, { url: cfg.url });
  if (!(cfg.qualityProfileId > 0) || !cfg.rootFolder) {
    return radarrResult('unconfigured', null, {
      url: radarrAddPageUrl(cfg, radarrSearchTerm(movie)),
      message: 'Choose a quality profile and root folder in ReelHop settings first.'
    });
  }

  try {
    const found = await radarrLookup(movie, cfg);
    if (found.status === 'in_library') {
      return radarrResult('in_library', found.movie, { url: radarrMovieUrl(cfg, found.movie), alreadyAdded: true });
    }
    if (found.status !== 'missing') {
      return radarrResult('not_found', null, { url: radarrAddPageUrl(cfg, radarrSearchTerm(movie)) });
    }

    const body = {
      ...found.movie,
      id: 0,
      qualityProfileId: cfg.qualityProfileId,
      rootFolderPath: cfg.rootFolder,
      monitored: true,
      minimumAvailability: cfg.minAvailability,
      tags: [],
      addOptions: { searchForMovie: cfg.searchOnAdd, monitor: 'movieOnly' }
    };
    const res = await radarrFetch(cfg, '/movie', { method: 'POST', body: JSON.stringify(body) }, 15000);

    if (res.status === 400) {
      const errors = await res.json().catch(() => null);
      const message = Array.isArray(errors)
        ? errors.map(e => e && e.errorMessage).filter(Boolean).join(' ')
        : 'Radarr rejected the movie.';
      // A list sync or another client beat us to it: report the library copy.
      if (/already/i.test(message)) {
        const again = await radarrLookup(movie, cfg);
        if (again.status === 'in_library') {
          return radarrResult('in_library', again.movie, { url: radarrMovieUrl(cfg, again.movie), alreadyAdded: true });
        }
      }
      return radarrResult('error', found.movie, { url: radarrAddPageUrl(cfg, radarrSearchTerm(movie)), message });
    }
    if (!res.ok) throw new RadarrHttpError(res.status);

    const added = await res.json();
    return radarrResult('in_library', added, { url: radarrMovieUrl(cfg, added), justAdded: true });
  } catch (e) {
    return radarrFailure(cfg, e);
  }
}

// Popup "Connect": verify URL + key, and fetch the options the add flow needs.
async function radarrTest(input) {
  const cfg = { url: normalizeRadarrUrl(input.url), apiKey: (input.apiKey || '').trim() };
  if (!cfg.url) return { ok: false, reason: 'bad_url' };
  if (!cfg.apiKey) return { ok: false, reason: 'no_key' };
  if (!(await hasRadarrPermission(cfg.url))) return { ok: false, reason: 'permission', url: cfg.url };

  try {
    const statusRes = await radarrFetch(cfg, '/system/status');
    if (statusRes.status === 401) return { ok: false, reason: 'unauthorized' };
    if (!statusRes.ok) return { ok: false, reason: 'http', status: statusRes.status };
    const status = await statusRes.json();
    if (status.appName && status.appName !== 'Radarr') {
      return { ok: false, reason: 'wrong_app', appName: status.appName };
    }

    const [profilesRes, rootsRes] = await Promise.all([
      radarrFetch(cfg, '/qualityprofile'),
      radarrFetch(cfg, '/rootfolder')
    ]);
    const profiles = profilesRes.ok
      ? (await profilesRes.json()).map(p => ({ id: p.id, name: p.name }))
      : [];
    const rootFolders = rootsRes.ok
      ? (await rootsRes.json()).map(r => ({ id: r.id, path: r.path, freeSpace: r.freeSpace }))
      : [];

    return {
      ok: true,
      url: cfg.url,
      version: status.version || '',
      instanceName: status.instanceName || 'Radarr',
      profiles,
      rootFolders
    };
  } catch (e) {
    return { ok: false, reason: 'unreachable', message: (e && e.message) || '' };
  }
}

// ===========================================================================
// Message router
// ===========================================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.action) {
        case 'plexResolve':
          sendResponse(await plexResolve(msg.movie));
          break;
        case 'plexTest':
          sendResponse(await plexTest(msg.token));
          break;
        case 'radarrResolve':
          sendResponse(await radarrResolve(msg.movie));
          break;
        case 'radarrAdd':
          sendResponse(await radarrAdd(msg.movie));
          break;
        case 'radarrTest':
          sendResponse(await radarrTest(msg.config || {}));
          break;
        case 'openPopup':
          // Best effort: lets an on-page "Needs access" button open settings.
          try {
            await chrome.action.openPopup();
            sendResponse({ ok: true });
          } catch (e) {
            sendResponse({ ok: false });
          }
          break;
        default:
          sendResponse({ error: `Unknown action: ${msg.action}` });
      }
    } catch (e) {
      sendResponse({ error: e.message });
    }
  })();
  return true; // keep the message channel open for the async response
});
