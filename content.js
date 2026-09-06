// ReelHop - Content Script
//
// Adds destination buttons ("Open in Plex", "Add to Radarr", ...) to movie
// pages. The engine at the bottom is site-agnostic: it picks whichever
// SITE_ADAPTER matches the current page, asks it to extract the film and place
// the buttons, and delegates every network call to the background worker.
//
// Two kinds of plug-in live here:
//   - Site adapters (SITE_ADAPTERS): how to read a film from, and inject
//     buttons into, one website. LETTERBOXD is the fully commented reference.
//   - Destination state: Plex (displayState) and Radarr (radarrState), each
//     resolved independently in the background so one can't stall the other.
(function () {
  'use strict';

  const CACHE_PREFIX = 'cacheTarget_';
  const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
  const INJECTED_CLASS = 'reelhop-injected'; // marks every top-level node we add
  const LINK_CLASS = 'reelhop-link';         // marks every Plex anchor
  const RADARR_CLASS = 'reelhop-radarr';     // marks every Radarr anchor
  const BADGE_CLASS = 'reelhop-badge';       // the status chip inside a button

  let currentUrl = '';
  let isResolvingPlex = false;
  let isResolvingRadarr = false;
  let injectScheduled = false;
  let lastSettings = null;
  // Per-destination display state for the current film, kept across dynamic
  // re-renders so a mid-resolve "Checking…" (or the final result) survives the
  // page mutating. Each carries the film token it belongs to.
  let displayState = null; // Plex:   { token, url, type, serverName }
  let radarrState = null;  // Radarr: { token, status, url, canAdd, hasFile, ... }
  // Radarr answers are memoized only for the page's lifetime: "not in your
  // library" has to go stale the moment the user clicks Add.
  const radarrMemo = new Map();
  const RADARR_RECHECK_MS = 30 * 1000; // re-ask when a tab returns to view after this long

  // ---------------------------------------------------------------------------
  // Shared helpers (used by every adapter)
  // ---------------------------------------------------------------------------

  function sanitizeText(str) {
    if (!str) return '';
    return str
      .replace(/[\u00A0\u1680\u180e\u2000-\u200b\u202f\u205f\u3000\ufeff]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function createSvgIcon(pathData, fill) {
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.display = 'inline-block';
    svg.style.verticalAlign = 'middle';
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('fill', fill);
    path.setAttribute('d', pathData);
    svg.appendChild(path);
    return svg;
  }

  function createPlexIcon() {
    return createSvgIcon('M3.5 2.5h6l8.5 9.5-8.5 9.5h-6l8.5-9.5L3.5 2.5z', '#E5A00D');
  }

  function createRadarrIcon() {
    // Down-arrow into a tray: "fetch this into my library".
    return createSvgIcon('M11 3h2v9.17l3.59-3.58L18 10l-6 6-6-6 1.41-1.41L11 12.17V3zM4 15h2v4h12v-4h2v6H4v-6z', '#FFC230');
  }

  function getSearchUrl(title, year) {
    const cleanTitle = sanitizeText(title);
    const cleanYear = sanitizeText(year);
    const q = cleanYear ? `${cleanTitle} ${cleanYear}` : cleanTitle;
    return `https://app.plex.tv/desktop/#!/search?query=${encodeURIComponent(q)}`;
  }

  function badgeLabelFor(type) {
    if (type === 'checking') return 'Checking…';
    if (type === 'server') return 'On Server';
    if (type === 'discover') return 'Discover';
    return 'Search';
  }

  function applyLinkTarget(el, settings) {
    if (settings.openInNewTab) {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    } else {
      el.removeAttribute('target');
      el.removeAttribute('rel');
    }
  }

  // Build a Plex anchor tagged with the shared marker class so the engine can
  // find and update it later (href + on-server state) once resolution completes.
  function createPlexAnchor(url, settings, type, className) {
    const a = document.createElement('a');
    a.href = url;
    a.className = `${className} ${LINK_CLASS}${type === 'server' ? ' on-server' : ''}`;
    applyLinkTarget(a, settings);
    return a;
  }

  // A full "Open in Plex" button: icon + label + mode badge. Sites pass their
  // own className for styling; the shared badge classes drive the color.
  function createPlexButton(url, settings, type, className) {
    const link = createPlexAnchor(url, settings, type, className);
    link.title = 'Open in Plex';
    link.appendChild(createPlexIcon());

    const label = document.createElement('span');
    label.className = 'reelhop-btn-label';
    label.textContent = 'Open in Plex';
    link.appendChild(label);

    const badge = document.createElement('span');
    badge.className = `${BADGE_CLASS} ${type}`;
    badge.textContent = badgeLabelFor(type);
    link.appendChild(badge);
    return link;
  }

  // What a Radarr button should say for a given state. `tone` picks the chip
  // color; `isAction` means a plain click does something other than navigate.
  function radarrView(state) {
    const s = state || { status: 'checking' };
    switch (s.status) {
      case 'checking':
        return { label: 'Radarr', badge: 'Checking…', tone: 'checking', title: 'Checking Radarr…' };
      case 'adding':
        return { label: 'Add to Radarr', badge: 'Adding…', tone: 'checking', title: 'Adding to Radarr…' };
      case 'in_library': {
        const badge = s.justAdded ? 'Added' : s.hasFile ? 'Downloaded' : s.monitored ? 'Wanted' : 'Unmonitored';
        const tone = (s.justAdded || s.hasFile) ? 'ok' : s.monitored ? 'warn' : 'neutral';
        return { label: 'Open in Radarr', badge, tone, title: `In your Radarr library (${badge.toLowerCase()})` };
      }
      case 'missing':
        return s.canAdd
          ? { label: 'Add to Radarr', badge: 'Add', tone: 'action', title: 'Add this movie to Radarr with your default profile and root folder' }
          : { label: 'Add in Radarr', badge: 'Not added', tone: 'neutral', title: 'Open Radarr to add this movie' };
      case 'not_found':
        return { label: 'Search in Radarr', badge: 'Not found', tone: 'neutral', title: 'Radarr could not match this title; opens a Radarr search' };
      case 'unauthorized':
        return { label: 'Radarr', badge: 'Bad API key', tone: 'err', title: 'Radarr rejected the API key. Check ReelHop settings.' };
      case 'permission':
        return { label: 'Radarr', badge: 'Needs access', tone: 'err', title: 'Open ReelHop settings and press Save to grant access to your Radarr URL.' };
      case 'unconfigured':
        return { label: 'Radarr', badge: 'Setup', tone: 'err', title: s.message || 'Finish Radarr setup in ReelHop settings.' };
      case 'error':
        return { label: 'Radarr', badge: 'Failed', tone: 'err', title: s.message || 'Radarr returned an error' };
      default:
        return { label: 'Radarr', badge: 'Unreachable', tone: 'err', title: s.message ? `Radarr: ${s.message}` : 'Could not reach Radarr' };
    }
  }

  function paintRadarrButton(a, state) {
    const v = radarrView(state);
    a.href = (state && state.url) || '#';
    a.title = v.title;
    a.dataset.status = state ? state.status : 'checking';
    a.querySelector('.reelhop-btn-label').textContent = v.label;
    const badge = a.querySelector(`.${BADGE_CLASS}`);
    badge.className = `${BADGE_CLASS} ${v.tone}`;
    badge.textContent = v.badge;
    a.classList.toggle('reelhop-checking', v.tone === 'checking');
  }

  function createRadarrButton(state, settings, className) {
    const a = document.createElement('a');
    a.className = `${className} ${RADARR_CLASS}`;
    applyLinkTarget(a, settings);
    a.appendChild(createRadarrIcon());

    const label = document.createElement('span');
    label.className = 'reelhop-btn-label';
    a.appendChild(label);

    const badge = document.createElement('span');
    badge.className = BADGE_CLASS;
    a.appendChild(badge);

    paintRadarrButton(a, state);
    return a;
  }

  // Keep exactly one Radarr button in `container` when there's a state to show,
  // and none otherwise (Radarr disabled, or the page is a TV show).
  function syncRadarrButton(container, state, settings, className) {
    if (!container) return;
    const existing = container.querySelector(`.${RADARR_CLASS}`);
    if (!state) {
      if (existing) existing.remove();
      return;
    }
    if (existing) {
      paintRadarrButton(existing, state);
    } else {
      container.appendChild(createRadarrButton(state, settings, className));
    }
  }

  // Walk up from an element to the first opaque background and decide whether
  // it's light. Used so the IMDb buttons stay readable on the white
  // "Reference view" as well as the standard dark title pages.
  function isLightBackground(el) {
    let node = el;
    for (let i = 0; node && i < 12; i++) {
      const bg = getComputedStyle(node).backgroundColor;
      const m = bg && bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
      if (m) {
        const alpha = m[4] === undefined ? 1 : parseFloat(m[4]);
        if (alpha > 0.1) {
          const lum = (0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3]) / 255;
          return lum > 0.6;
        }
      }
      node = node.parentElement;
    }
    return false; // default to the dark treatment
  }

  function readImdbIdFromLinks() {
    const imdbLink = document.querySelector('a[href*="imdb.com/title/"]');
    if (imdbLink) {
      const match = imdbLink.href.match(/(tt\d+)/);
      if (match) return match[1];
    }
    return '';
  }

  // ---------------------------------------------------------------------------
  // Site adapters
  //
  // Adapter interface:
  //   id                   string   unique, used to namespace the cache
  //   isFilmPage()         boolean  is the current URL a film page on this site?
  //   getKey()             string   stable id for the current film (cache key)
  //   extract()            {title, year, imdbId, tmdbId, type} | null
  //                        type is 'movie' | 'show' | '' (unknown)
  //   inject(view, settings)        idempotently place buttons in the page.
  //                        view = { plex: {url, type}, radarr: state | null }
  //   isInjected(settings) boolean  are this site's containers still present?
  // Top-level injected nodes must carry INJECTED_CLASS so the engine can clean
  // them up on navigation; build buttons with createPlexButton /
  // syncRadarrButton so the engine can repaint them when a destination resolves.
  // ---------------------------------------------------------------------------

  const LETTERBOXD = {
    id: 'letterboxd',

    isFilmPage() {
      return location.hostname.endsWith('letterboxd.com') &&
             location.pathname.startsWith('/film/');
    },

    getKey() {
      return location.pathname.split('/').filter(Boolean)[1] || location.pathname;
    },

    extract() {
      const ogTitle = document.querySelector('meta[property="og:title"]')?.content || '';
      const headline = document.querySelector('h1.headline-1')?.innerText ||
                       document.querySelector('section#featured-film-header h1')?.innerText ||
                       document.querySelector('.film-header-group h1')?.innerText || '';

      const title = sanitizeText(headline || ogTitle).replace(/\s*\(\d{4}\)\s*$/, '').trim();

      let year = '';
      const yearEl = document.querySelector('.releaseyear a') || document.querySelector('.releaseyear');
      if (yearEl) {
        year = sanitizeText(yearEl.innerText);
      } else {
        const yearMatch = (ogTitle || document.title).match(/\((\d{4})\)/);
        if (yearMatch) year = yearMatch[1];
      }

      // Letterboxd calls everything a "film" (og:type is always video.movie),
      // but its TMDB link tells us whether this is really a movie or a show.
      let tmdbId = '';
      let type = '';
      const tmdbLink = document.querySelector('a[href*="themoviedb.org/movie/"], a[href*="themoviedb.org/tv/"]');
      if (tmdbLink) {
        const match = tmdbLink.href.match(/themoviedb\.org\/(movie|tv)\/(\d+)/);
        if (match) {
          tmdbId = match[2];
          type = match[1] === 'tv' ? 'show' : 'movie';
        }
      }

      return { title, year, imdbId: readImdbIdFromLinks(), tmdbId, type };
    },

    inject(view, settings) {
      if (settings.showSidebarButton) {
        this._injectSidebar(view, settings);
      } else {
        document.getElementById('reelhop-sidebar-actions')?.remove();
      }

      if (settings.showWatchPanel) {
        this._injectWatchPanelBadge(view.plex, settings);
      } else {
        document.getElementById('reelhop-watch-plex')?.remove();
      }

      if (settings.showDetailsLink) {
        this._injectHeaderMetadataLink(view.plex, settings);
      } else {
        document.getElementById('reelhop-meta-plex')?.remove();
      }
    },

    isInjected(settings) {
      if (!settings) return false;
      return (!settings.showSidebarButton || document.getElementById('reelhop-sidebar-actions')) &&
             (!settings.showWatchPanel || document.getElementById('reelhop-watch-plex')) &&
             (!settings.showDetailsLink || document.getElementById('reelhop-meta-plex'));
    },

    // Sidebar: a stacked group with one button per destination.
    _injectSidebar(view, settings) {
      let wrapper = document.getElementById('reelhop-sidebar-actions');
      if (!wrapper) {
        const targetContainer = document.querySelector('ul.film-stats') ||
                                document.querySelector('.actions-panel') ||
                                document.querySelector('aside.sidebar .sidebar-content');
        if (!targetContainer) return;

        wrapper = document.createElement('div');
        wrapper.id = 'reelhop-sidebar-actions';
        wrapper.className = `reelhop-sidebar-actions ${INJECTED_CLASS}`;
        wrapper.appendChild(createPlexButton(view.plex.url, settings, view.plex.type, 'reelhop-sidebar-btn'));

        if (targetContainer.tagName === 'UL') {
          const li = document.createElement('li');
          li.className = INJECTED_CLASS;
          li.style.listStyle = 'none';
          li.style.margin = '8px 0';
          li.appendChild(wrapper);
          targetContainer.parentNode.insertBefore(li, targetContainer.nextSibling);
        } else {
          targetContainer.appendChild(wrapper);
        }
      }
      syncRadarrButton(wrapper, view.radarr, settings, 'reelhop-sidebar-btn');
    },

    _createWatchBadge(plex, settings) {
      const item = document.createElement('p');
      item.id = 'reelhop-watch-plex';
      item.className = `service -plex ${INJECTED_CLASS}${plex.type === 'server' ? ' on-server' : ''}`;

      const link = createPlexAnchor(plex.url, settings, plex.type, 'label track-event tooltip');
      link.setAttribute('data-original-title', 'View on Plex');

      const brand = document.createElement('span');
      brand.className = 'brand';
      brand.appendChild(createPlexIcon());
      link.appendChild(brand);

      const titleSpan = document.createElement('span');
      titleSpan.className = 'title';
      titleSpan.textContent = 'Plex';
      link.appendChild(titleSpan);

      item.appendChild(link);
      return item;
    },

    // "Where to watch" is about watching, so only Plex belongs here.
    _injectWatchPanelBadge(plex, settings) {
      if (document.getElementById('reelhop-watch-plex')) return;

      const servicesList = document.querySelector('section.services') ||
                           document.querySelector('.services') ||
                           document.querySelector('div.js-watch-panel .services');

      if (servicesList) {
        servicesList.insertBefore(this._createWatchBadge(plex, settings), servicesList.firstChild);
      } else {
        const notStreamingMsg = document.querySelector('.js-not-streaming') ||
                                document.querySelector('section.watch-panel .other.-message');
        if (notStreamingMsg && notStreamingMsg.parentNode) {
          const customServices = document.createElement('section');
          customServices.className = `services ${INJECTED_CLASS}`;
          customServices.appendChild(this._createWatchBadge(plex, settings));
          notStreamingMsg.parentNode.insertBefore(customServices, notStreamingMsg);
        }
      }
    },

    _injectHeaderMetadataLink(plex, settings) {
      if (document.getElementById('reelhop-meta-plex')) return;

      const externalLinksContainer = document.querySelector('a[data-track-action="IMDb"]')?.parentNode ||
                                     document.querySelector('a[data-track-action="TMDB"]')?.parentNode ||
                                     document.querySelector('.track-event[href*="imdb.com"]')?.parentNode;

      if (externalLinksContainer) {
        const metaLink = createPlexAnchor(plex.url, settings, plex.type, `reelhop-meta-link ${INJECTED_CLASS}`);
        metaLink.id = 'reelhop-meta-plex';
        metaLink.title = 'View on Plex';
        metaLink.appendChild(createPlexIcon());
        metaLink.appendChild(document.createTextNode(' Plex'));
        externalLinksContainer.appendChild(metaLink);
      }
    }
  };

  const IMDB = {
    id: 'imdb',

    isFilmPage() {
      return /(^|\.)imdb\.com$/.test(location.hostname) &&
             /^\/title\/tt\d+/.test(location.pathname);
    },

    getKey() {
      const m = location.pathname.match(/\/title\/(tt\d+)/);
      return m ? m[1] : location.pathname;
    },

    extract() {
      const idMatch = location.pathname.match(/\/title\/(tt\d+)/);
      const imdbId = idMatch ? idMatch[1] : '';

      let title = '';
      let year = '';
      let ldType = '';

      // Primary: JSON-LD is clean and locale-independent.
      for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const parsed = JSON.parse(script.textContent);
          const node = Array.isArray(parsed) ? parsed.find(d => d && d.name) : parsed;
          if (node && typeof node.name === 'string' && node.name) {
            title = sanitizeText(node.name);
            if (typeof node['@type'] === 'string') ldType = node['@type'];
            if (typeof node.datePublished === 'string' && /^\d{4}/.test(node.datePublished)) {
              year = node.datePublished.slice(0, 4);
            }
            break;
          }
        } catch (e) { /* ignore malformed blocks */ }
      }

      // Fallback: hero heading, then og:title.
      if (!title) {
        const h1 = document.querySelector('h1[data-testid="hero__pageTitle"]');
        if (h1) title = sanitizeText(h1.textContent);
      }
      if (!title) {
        const og = document.querySelector('meta[property="og:title"]')?.content || '';
        title = sanitizeText(og.replace(/\s[-–|]\s.*$/, ''));
        const ym = og.match(/\((\d{4})\)/);
        if (ym && !year) year = ym[1];
      }
      if (!year) {
        const relEl = document.querySelector('a[href*="releaseinfo"]');
        const ym = relEl && sanitizeText(relEl.textContent).match(/\d{4}/);
        if (ym) year = ym[0];
      }

      title = title.replace(/\s*\(\d{4}\)\s*$/, '').trim();

      // Media type: og:type is present on both the standard and reference
      // views and is locale-independent; fall back to the JSON-LD @type.
      const ogType = document.querySelector('meta[property="og:type"]')?.content || '';
      let type = '';
      if (ogType === 'video.tv_show') type = 'show';
      else if (ogType === 'video.movie') type = 'movie';
      else if (/tv|series|episode/i.test(ldType)) type = 'show';
      else if (/movie/i.test(ldType)) type = 'movie';

      if (!title && !imdbId) return null;
      return { title, year, imdbId, tmdbId: '', type };
    },

    // One row of pill buttons under the title metadata, one per destination.
    inject(view, settings) {
      if (!settings.showImdbButton) {
        document.getElementById('reelhop-imdb-row')?.remove();
        return;
      }

      let row = document.getElementById('reelhop-imdb-row');
      if (!row) {
        const h1 = document.querySelector('h1[data-testid="hero__pageTitle"]');
        const host = h1 && h1.parentElement;
        if (!host) return;

        row = document.createElement('div');
        row.id = 'reelhop-imdb-row';
        row.className = `reelhop-imdb-row ${INJECTED_CLASS}`;
        if (isLightBackground(host)) row.classList.add('reelhop-imdb-row--light');
        row.appendChild(createPlexButton(view.plex.url, settings, view.plex.type, 'reelhop-imdb-btn'));
        host.appendChild(row);
      }
      syncRadarrButton(row, view.radarr, settings, 'reelhop-imdb-btn');
    },

    isInjected(settings) {
      if (!settings.showImdbButton) return true; // nothing to inject
      return !!document.getElementById('reelhop-imdb-row');
    }
  };

  const SITE_ADAPTERS = [LETTERBOXD, IMDB];

  function getActiveAdapter() {
    return SITE_ADAPTERS.find(a => a.isFilmPage()) || null;
  }

  // ---------------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------------

  function getSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get([
        'plexToken',
        'openInNewTab',
        'showSidebarButton',
        'showWatchPanel',
        'showDetailsLink',
        'showImdbButton',
        'radarrEnabled',
        'radarrUrl'
      ], (items) => {
        lastSettings = {
          plexToken: items.plexToken || '',
          openInNewTab: items.openInNewTab !== false,
          showSidebarButton: items.showSidebarButton !== false,
          showWatchPanel: items.showWatchPanel !== false,
          showDetailsLink: items.showDetailsLink !== false,
          showImdbButton: items.showImdbButton !== false,
          radarrEnabled: items.radarrEnabled === true,
          radarrUrl: (items.radarrUrl || '').trim()
        };
        resolve(lastSettings);
      });
    });
  }

  function cacheKey(adapterId, filmKey) {
    return `${CACHE_PREFIX}${adapterId}_${filmKey}`;
  }

  function getCachedResult(adapterId, filmKey) {
    return new Promise((resolve) => {
      const key = cacheKey(adapterId, filmKey);
      chrome.storage.local.get(key, (items) => {
        const data = items[key];
        if (data && data.url && Date.now() - data.timestamp < CACHE_TTL) {
          resolve(data);
        } else {
          resolve(null);
        }
      });
    });
  }

  function setCachedResult(adapterId, filmKey, result) {
    chrome.storage.local.set({
      [cacheKey(adapterId, filmKey)]: { ...result, timestamp: Date.now() }
    });
  }

  // ---------------------------------------------------------------------------
  // Engine
  // ---------------------------------------------------------------------------

  function currentFilmToken() {
    const adapter = getActiveAdapter();
    return adapter ? `${adapter.id}|${adapter.getKey()}` : null;
  }

  // Radarr is movies-only; skip it for shows and when it isn't set up.
  function radarrWanted(settings, movie) {
    return settings.radarrEnabled && !!settings.radarrUrl && movie.type !== 'show';
  }

  function radarrStateFrom(result, filmToken, settings) {
    if (!result || result.error) {
      return { token: filmToken, status: 'unreachable', url: settings.radarrUrl, message: result && result.error };
    }
    return { token: filmToken, ...result, url: result.url || settings.radarrUrl };
  }

  // Repaint whatever buttons are on the page from the stored states — but only
  // if they still describe the film on screen.
  function applyDisplayState(token) {
    if (displayState && displayState.token === token) {
      updateAllPlexLinks(displayState.url, displayState.type, displayState.serverName);
    }
    if (radarrState && radarrState.token === token) {
      document.querySelectorAll(`.${RADARR_CLASS}`).forEach((a) => paintRadarrButton(a, radarrState));
    }
  }

  // Re-run the adapter's inject with the current states (adds/removes buttons
  // as destinations come and go), then repaint.
  function renderCurrent() {
    const adapter = getActiveAdapter();
    if (!adapter || !lastSettings) return;
    const token = currentFilmToken();
    if (!displayState || displayState.token !== token) return;
    adapter.inject({
      plex: displayState,
      radarr: radarrState && radarrState.token === token ? radarrState : null
    }, lastSettings);
    applyDisplayState(token);
  }

  async function injectLinks() {
    const adapter = getActiveAdapter();
    if (!adapter) return;

    const movie = adapter.extract();
    if (!movie || !movie.title) return;

    const settings = await getSettings();
    const filmKey = adapter.getKey();
    const filmToken = `${adapter.id}|${filmKey}`;

    // Plex: a search link right away, or the cached deep link if we have one.
    let plexUrl = getSearchUrl(movie.title, movie.year);
    let plexType = 'search';
    const cached = await getCachedResult(adapter.id, filmKey);
    if (cached) {
      plexUrl = cached.url;
      plexType = cached.type || 'discover';
    }
    if (!displayState || displayState.token !== filmToken) {
      displayState = { token: filmToken, url: plexUrl, type: plexType };
    }

    // Radarr: the memoized answer, or "Checking…" until the worker replies.
    if (!radarrWanted(settings, movie)) {
      radarrState = null;
    } else if (!radarrState || radarrState.token !== filmToken) {
      radarrState = radarrMemo.get(filmToken) ||
                    { token: filmToken, status: 'checking', url: settings.radarrUrl };
    }

    adapter.inject({ plex: displayState, radarr: radarrState }, settings);
    applyDisplayState(filmToken);

    // Resolve each destination in the background worker, in parallel.
    const jobs = [];
    if (!cached && settings.plexToken && !isResolvingPlex) {
      jobs.push(resolvePlex(adapter, movie, filmKey, filmToken, plexUrl));
    }
    if (radarrState && radarrState.status === 'checking' && !isResolvingRadarr) {
      jobs.push(resolveRadarr(movie, filmToken, settings));
    }
    await Promise.all(jobs);
  }

  async function resolvePlex(adapter, movie, filmKey, filmToken, fallbackUrl) {
    isResolvingPlex = true;
    displayState = { token: filmToken, url: fallbackUrl, type: 'checking' };
    applyDisplayState(filmToken);
    try {
      const resolved = await chrome.runtime.sendMessage({ action: 'plexResolve', movie });
      if (resolved && resolved.url && !resolved.error) {
        setCachedResult(adapter.id, filmKey, resolved);
        if (currentFilmToken() === filmToken) {
          displayState = { token: filmToken, url: resolved.url, type: resolved.type, serverName: resolved.serverName };
        }
      } else if (currentFilmToken() === filmToken) {
        displayState = { token: filmToken, url: fallbackUrl, type: 'search' };
      }
    } catch (e) {
      console.warn('[ReelHop] Plex resolve failed:', e);
      if (currentFilmToken() === filmToken) {
        displayState = { token: filmToken, url: fallbackUrl, type: 'search' };
      }
    } finally {
      isResolvingPlex = false;
      applyDisplayState(filmToken);
      // The user moved on mid-flight: make sure the new film gets its own turn.
      if (currentFilmToken() !== filmToken) scheduleInject();
    }
  }

  async function resolveRadarr(movie, filmToken, settings) {
    isResolvingRadarr = true;
    try {
      const result = await chrome.runtime.sendMessage({ action: 'radarrResolve', movie });
      if (currentFilmToken() === filmToken) {
        if (result && result.status === 'disabled') {
          radarrState = null;
        } else {
          radarrState = radarrStateFrom(result, filmToken, settings);
          if (['in_library', 'missing', 'not_found'].includes(radarrState.status)) {
            radarrMemo.set(filmToken, { ...radarrState, at: Date.now() });
          }
        }
      }
    } catch (e) {
      console.warn('[ReelHop] Radarr resolve failed:', e);
      if (currentFilmToken() === filmToken) {
        radarrState = { token: filmToken, status: 'unreachable', url: settings.radarrUrl, message: e.message };
      }
    } finally {
      isResolvingRadarr = false;
      renderCurrent();
      if (currentFilmToken() !== filmToken) scheduleInject();
    }
  }

  // One-click add, triggered from a Radarr button in the 'missing' state.
  async function addToRadarr() {
    const adapter = getActiveAdapter();
    if (!adapter || !lastSettings) return;
    const movie = adapter.extract();
    const filmToken = currentFilmToken();
    if (!movie || !radarrState || radarrState.token !== filmToken || radarrState.status !== 'missing') return;

    radarrState = { ...radarrState, status: 'adding' };
    applyDisplayState(filmToken);

    let result;
    try {
      result = await chrome.runtime.sendMessage({ action: 'radarrAdd', movie });
    } catch (e) {
      result = { error: e.message };
    }
    if (currentFilmToken() !== filmToken) return;

    radarrState = radarrStateFrom(result, filmToken, lastSettings);
    if (radarrState.status === 'in_library') {
      radarrMemo.set(filmToken, { ...radarrState, at: Date.now() });
    } else {
      radarrMemo.delete(filmToken);
    }
    applyDisplayState(filmToken);
  }

  // Radarr buttons are anchors (so middle-click / "open in new tab" still work)
  // but a plain left click on an actionable one does the action instead.
  function onDocumentClick(e) {
    const btn = e.target && e.target.closest ? e.target.closest(`.${RADARR_CLASS}`) : null;
    if (!btn) return;
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

    const status = btn.dataset.status;
    if (status === 'missing' && radarrState && radarrState.canAdd) {
      e.preventDefault();
      e.stopPropagation();
      addToRadarr();
    } else if (status === 'permission' || status === 'unconfigured') {
      e.preventDefault();
      e.stopPropagation();
      const href = btn.href;
      chrome.runtime.sendMessage({ action: 'openOptions', section: 'radarr' })
        .then((res) => { if (!(res && res.ok) && href && !href.endsWith('#')) window.open(href, '_blank', 'noopener'); })
        .catch(() => { if (href && !href.endsWith('#')) window.open(href, '_blank', 'noopener'); });
    } else if (status === 'checking' || status === 'adding') {
      e.preventDefault();
    }
  }

  function updateAllPlexLinks(url, type, serverName) {
    const checking = type === 'checking';

    document.querySelectorAll(`.${LINK_CLASS}`).forEach((el) => {
      if (url) el.href = url;
      el.classList.toggle('on-server', type === 'server');
      el.classList.toggle('reelhop-checking', checking);
      if (type === 'server' && serverName) {
        el.title = `Watch on Plex Server (${serverName})`;
      } else if (checking) {
        el.title = 'Checking Plex…';
      } else {
        el.title = 'Open in Plex';
      }
    });

    document.querySelectorAll(`.${LINK_CLASS} .${BADGE_CLASS}`).forEach((el) => {
      el.className = `${BADGE_CLASS} ${type}`;
      el.textContent = badgeLabelFor(type);
    });

    const watchBadge = document.getElementById('reelhop-watch-plex');
    if (watchBadge) {
      watchBadge.classList.toggle('on-server', type === 'server');
      watchBadge.classList.toggle('reelhop-checking', checking);
    }
  }

  function removeAllInjected() {
    document.querySelectorAll(`.${INJECTED_CLASS}`).forEach((el) => el.remove());
  }

  function allLinksInjected() {
    const adapter = getActiveAdapter();
    if (!adapter) return true; // nothing to inject here
    return adapter.isInjected(lastSettings);
  }

  function scheduleInject() {
    if (injectScheduled) return;
    injectScheduled = true;
    setTimeout(() => {
      injectScheduled = false;
      if (getActiveAdapter()) injectLinks();
    }, 250);
  }

  function handleUrlChange() {
    if (location.href !== currentUrl) {
      currentUrl = location.href;
      removeAllInjected();
      scheduleInject();
    }
  }

  function init() {
    currentUrl = location.href;
    if (getActiveAdapter()) injectLinks();

    const observer = new MutationObserver(() => {
      handleUrlChange();
      // Sites re-render dynamically; re-inject if our nodes were wiped, but
      // skip the work when everything expected is already present.
      if (getActiveAdapter() && !allLinksInjected()) {
        scheduleInject();
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener('click', onDocumentClick, true);
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      // Radarr settings changed: forget what we knew and ask again.
      if (Object.keys(changes).some(k => k.startsWith('radarr'))) {
        radarrMemo.clear();
        radarrState = null;
      }
      scheduleInject();
    });
    // A tab left open while Radarr finishes a download would otherwise keep
    // saying "Wanted". When the tab comes back into view and the answer is
    // old, ask again; the button repaints only once Radarr replies.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || isResolvingRadarr || !lastSettings) return;
      const token = currentFilmToken();
      const memo = radarrMemo.get(token);
      if (!memo || Date.now() - (memo.at || 0) < RADARR_RECHECK_MS) return;
      const adapter = getActiveAdapter();
      const movie = adapter && adapter.isFilmPage() ? adapter.extract() : null;
      if (movie && radarrWanted(lastSettings, movie)) resolveRadarr(movie, token, lastSettings);
    });
    window.addEventListener('popstate', handleUrlChange);
    document.addEventListener('turbo:load', handleUrlChange);
    document.addEventListener('turbolinks:load', handleUrlChange);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
