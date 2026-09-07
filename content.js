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
//   - Destination state: Plex (displayState) and the library manager
//     (libraryState), resolved independently in the background so one can't
//     stall the other. A title is either a movie or a show, so the library
//     button is a single slot pointing at Radarr or Sonarr as appropriate.
//
// A third, Letterboxd-only module (Poster badges) marks posters on grids,
// lists and the watchlist with a Plex chip when the title is on the user's
// server, and offers a bar above the grid for filtering it down to what is
// (or isn't) on Plex. It batches whole pages into one message, so it costs
// nothing per poster.
(function () {
  'use strict';

  // Pure helpers shared with the worker and the settings page (shared.js runs
  // first in this same isolated world; see manifest content_scripts).
  const {
    sanitizeText, parseTitleYear, badgeLabelFor, libraryView,
    posterAddView, posterSizeClass, posterHidden, gridCounts
  } = ReelHop;

  const CACHE_PREFIX = 'cacheTarget_';
  const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
  const INJECTED_CLASS = 'reelhop-injected'; // marks every top-level node we add
  const LINK_CLASS = 'reelhop-link';         // marks every Plex anchor
  const RADARR_CLASS = 'reelhop-radarr';     // marks every Radarr anchor
  const BADGE_CLASS = 'reelhop-badge';       // the status chip inside a button

  let currentUrl = '';
  let isResolvingPlex = false;
  let isResolvingLibrary = false;
  let injectScheduled = false;
  let lastSettings = null;
  // Per-destination display state for the current film, kept across dynamic
  // re-renders so a mid-resolve "Checking…" (or the final result) survives the
  // page mutating. Each carries the film token it belongs to.
  let displayState = null; // Plex:   { token, url, type, serverName }
  let libraryState = null;  // Radarr or Sonarr: { token, destination, status, url, canAdd, ... }
  // Library answers are memoized only for the page's lifetime: "not in your
  // library" has to go stale the moment the user clicks Add.
  const libraryMemo = new Map();
  const RADARR_RECHECK_MS = 30 * 1000; // re-ask when a tab returns to view after this long
  const FILTER_MODES = ['all', 'available', 'unavailable'];
  const RADARR_FILTER_MODES = ['all', 'in', 'out'];

  // ---------------------------------------------------------------------------
  // Shared helpers (used by every adapter)
  // ---------------------------------------------------------------------------

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

  function paintRadarrButton(a, state) {
    const v = libraryView(state);
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
        'showPosterBadges',
        'showPosterAdd',
        'showPosterFilter',
        'posterFilter',
        'posterFilterRadarr',
        'radarrEnabled',
        'radarrUrl',
        'sonarrEnabled',
        'sonarrUrl'
      ], (items) => {
        lastSettings = {
          plexToken: items.plexToken || '',
          openInNewTab: items.openInNewTab !== false,
          showSidebarButton: items.showSidebarButton !== false,
          showWatchPanel: items.showWatchPanel !== false,
          showDetailsLink: items.showDetailsLink !== false,
          showImdbButton: items.showImdbButton !== false,
          showPosterBadges: items.showPosterBadges !== false,
          showPosterAdd: items.showPosterAdd !== false,
          showPosterFilter: items.showPosterFilter !== false,
          posterFilter: FILTER_MODES.includes(items.posterFilter) ? items.posterFilter : 'all',
          posterFilterRadarr: RADARR_FILTER_MODES.includes(items.posterFilterRadarr) ? items.posterFilterRadarr : 'all',
          radarrEnabled: items.radarrEnabled === true,
          radarrUrl: (items.radarrUrl || '').trim(),
          sonarrEnabled: items.sonarrEnabled === true,
          sonarrUrl: (items.sonarrUrl || '').trim()
        };
        resolve(lastSettings);
      });
    });
  }

  function cacheKey(adapterId, filmKey) {
    return `${CACHE_PREFIX}${adapterId}_${filmKey}`;
  }

  // Fresh cached results for many films at once: { filmKey: result }.
  function getCachedResults(adapterId, filmKeys) {
    return new Promise((resolve) => {
      const keys = filmKeys.map((k) => cacheKey(adapterId, k));
      chrome.storage.local.get(keys, (items) => {
        const out = {};
        filmKeys.forEach((filmKey, i) => {
          const data = items[keys[i]];
          if (data && data.url && Date.now() - data.timestamp < CACHE_TTL) out[filmKey] = data;
        });
        resolve(out);
      });
    });
  }

  function getCachedResult(adapterId, filmKey) {
    return getCachedResults(adapterId, [filmKey]).then((found) => found[filmKey] || null);
  }

  function setCachedResult(adapterId, filmKey, result) {
    chrome.storage.local.set({
      [cacheKey(adapterId, filmKey)]: { ...result, timestamp: Date.now() }
    });
  }

  // ---------------------------------------------------------------------------
  // Poster marks (Letterboxd only)
  //
  // Letterboxd draws every poster — browse grids, lists, the watchlist, a film
  // page's "similar films" — with one React component that carries the film's
  // slug and "Title (Year)". We collect the posters on the page and ask the
  // worker about all of them at once: plexLibraryMatch for what is on the
  // user's server, radarrLibraryMatch for what is already in Radarr. Each
  // poster then gets up to two small marks stacked in its corner — a Plex chip
  // that deep-links to the item, and a "+" that adds the film to Radarr.
  // Answers are kept for the page's lifetime so re-renders repaint for free.
  // ---------------------------------------------------------------------------

  // Letterboxd renders every poster with this one component; the link check
  // keeps us to films if it is ever reused for people, lists or other items.
  const POSTER_SELECTOR = '.react-component[data-item-slug][data-item-link^="/film/"]';
  const POSTER_MARKS_CLASS = 'reelhop-poster-marks';
  const POSTER_BADGE_CLASS = 'reelhop-poster-badge'; // the Plex chip
  const POSTER_ADD_CLASS = 'reelhop-poster-add';     // the Radarr "+"
  const POSTER_MIN_WIDTH = 60;   // thumbnails are too small for a chip
  const POSTER_MAX_WIDTH = 400;  // the film page's own poster already has buttons
  // Settings that invalidate what we know (ask again) vs. ones that only
  // change how it is drawn (repaint from memory).
  const POSTER_RESET_KEYS = ['plexToken', 'showPosterBadges', 'showPosterAdd',
                             'radarrEnabled', 'radarrUrl', 'radarrApiKey'];
  const POSTER_REFRESH_KEYS = ['openInNewTab', 'showPosterFilter', 'posterFilter', 'posterFilterRadarr'];
  const FILTER_BAR_ID = 'reelhop-poster-filter';
  const FILTER_HIDDEN_CLASS = 'reelhop-filtered-out';
  const FILTER_MIN_POSTERS = 8; // below this a grid is a preview strip, not a page of films
  const posterResults = new Map(); // slug -> Plex match | null
  const radarrPoster = new Map();  // slug -> { status, url, ... } | null (nothing to show)
  const posterKnown = new Set();   // slugs every enabled destination has answered for
  const posterPending = new Set(); // slugs queued or in flight
  let posterQueue = new Map();     // slug -> { title, year } waiting to be sent
  const radarrInLibrary = new Set(); // slugs Radarr already had, for the filter
  let radarrCanAdd = false;        // profile + root folder are set, so "+" adds in place
  let radarrPosterProblem = '';    // why the "+" buttons are missing, if they are
  let bulkArmed = false;           // the bulk add is one click from running
  let bulkState = { running: false, done: 0, total: 0, added: 0, failed: 0, report: '' };
  let posterFlushTimer = null;
  let posterScanTimer = null;

  function isLetterboxd() {
    return location.hostname.endsWith('letterboxd.com');
  }

  // Which destinations want to mark posters right now.
  function posterWants(settings) {
    return {
      plex: settings.showPosterBadges && !!settings.plexToken,
      radarr: settings.showPosterAdd && settings.radarrEnabled && !!settings.radarrUrl
    };
  }

  function posterWidth(el) {
    return parseInt(el.dataset.imageWidth, 10) || el.getBoundingClientRect().width || 0;
  }

  // "Title (Year)" from the component's data, or the image alt as a fallback.
  function posterFilm(el) {
    return parseTitleYear(el.dataset.itemName || el.dataset.itemFullDisplayName ||
                          (el.querySelector('img') || {}).alt || '');
  }

  // The stack of marks in the poster's corner, created on first use.
  function posterMarks(el, create) {
    const host = el.querySelector('.film-poster, .poster') || el;
    let marks = host.querySelector(`.${POSTER_MARKS_CLASS}`);
    if (!marks && create) {
      marks = document.createElement('div');
      marks.className = `${POSTER_MARKS_CLASS} ${INJECTED_CLASS} ${posterSizeClass(posterWidth(el))}`.trim();
      // Keep clicks off Letterboxd's own poster handlers (frame link, menu).
      marks.addEventListener('click', (e) => e.stopPropagation());
      host.appendChild(marks);
    }
    return marks;
  }

  function dropMarksIfEmpty(el) {
    const marks = posterMarks(el, false);
    if (marks && !marks.firstChild) marks.remove();
  }

  // Add, update or remove one poster's marks. Letterboxd mutates these grids
  // constantly (lazy images, hover cards) and every mutation costs a rescan,
  // so this returns early when the poster already looks the way we want.
  function paintPoster(el, view, settings) {
    const plex = view.plex || null;
    const add = view.add || null;
    const wantTarget = settings.openInNewTab ? '_blank' : null;
    const signature = [
      plex ? `plex:${plex.url}` : 'plex:-',
      add ? `add:${add.status || 'add'}:${add.url || ''}` : 'add:-',
      `t:${wantTarget || ''}`
    ].join('|');
    if (el.dataset.reelhopPoster === signature) return;

    const marks = posterMarks(el, !!(plex || add));

    // --- Plex chip
    let badge = marks && marks.querySelector(`.${POSTER_BADGE_CLASS}`);
    if (!plex) {
      if (badge) badge.remove();
    } else {
      if (!badge) {
        badge = document.createElement('a');
        badge.className = POSTER_BADGE_CLASS;
        badge.appendChild(createPlexIcon());
        marks.appendChild(badge);
      }
      badge.href = plex.url;
      badge.title = plex.serverName ? `On Plex (${plex.serverName})` : 'On Plex';
      badge.setAttribute('aria-label', badge.title);
      applyLinkTarget(badge, settings);
    }

    // --- Radarr "+"
    let plus = marks && marks.querySelector(`.${POSTER_ADD_CLASS}`);
    if (!add) {
      if (plus) plus.remove();
    } else {
      const v = posterAddView(add, radarrCanAdd);
      if (!plus) {
        plus = document.createElement('a');
        plus.className = POSTER_ADD_CLASS;
        const glyph = document.createElement('span');
        glyph.className = 'reelhop-poster-glyph';
        plus.appendChild(glyph);
        marks.appendChild(plus);
      }
      plus.dataset.status = add.status || 'add';
      plus.className = `${POSTER_ADD_CLASS} ${v.tone}`;
      plus.querySelector('.reelhop-poster-glyph').textContent = v.icon;
      plus.title = v.label;
      plus.setAttribute('aria-label', v.label);
      if (add.url) {
        plus.href = add.url;
        applyLinkTarget(plus, settings);
      } else {
        plus.removeAttribute('href');
      }
    }

    if (plex || add) el.dataset.reelhopPoster = signature;
    else delete el.dataset.reelhopPoster;
    dropMarksIfEmpty(el);
  }

  // What a poster should show, given everything we know about it.
  function posterView(slug, wants) {
    return {
      plex: wants.plex ? posterResults.get(slug) || null : null,
      // null in the map means "already in Radarr", which needs no button.
      add: wants.radarr ? radarrPoster.get(slug) || null : null
    };
  }


  // ---- Availability filter -------------------------------------------------
  // One bar above the page's main poster grid, with a group per destination:
  // Plex (All / On Plex / Not on Plex) and, when Radarr is on, Radarr (All /
  // In Radarr / Not in Radarr). They combine, so "Not on Plex" plus "Not in
  // Radarr" is everything on the page worth grabbing — which is also what the
  // bar's bulk add acts on. Both choices are stored, so they survive paging
  // through a list.

  // The grid this page is about: the one holding the most film posters. A
  // handful of posters is a preview strip (a list card, "similar films"), not
  // something worth filtering.
  function mainPosterGrid() {
    if (!isLetterboxd()) return null;
    const adapter = getActiveAdapter();
    if (adapter && adapter.id === 'letterboxd') return null; // film pages aren't browsing
    let best = null;
    let bestCount = 0;
    for (const ul of document.querySelectorAll('ul.poster-list, ul.grid')) {
      const n = ul.querySelectorAll(POSTER_SELECTOR).length;
      if (n > bestCount) { best = ul; bestCount = n; }
    }
    return bestCount >= FILTER_MIN_POSTERS ? best : null;
  }

  function currentModes(settings) {
    return {
      plex: settings.posterFilter,
      radarr: posterWants(settings).radarr ? settings.posterFilterRadarr : 'all'
    };
  }

  // One entry per poster in the grid, in the shape shared.js counts.
  function gridPosters(grid) {
    return [...grid.querySelectorAll(POSTER_SELECTOR)].map((el) => {
      const slug = el.dataset.itemSlug;
      return {
        el,
        slug,
        known: posterKnown.has(slug),
        plex: posterResults.get(slug),
        radarr: posterKnown.has(slug) ? radarrInLibrary.has(slug) : undefined
      };
    });
  }

  function setPosterFilter(dimension, mode) {
    const key = dimension === 'radarr' ? 'posterFilterRadarr' : 'posterFilter';
    const allowed = dimension === 'radarr' ? RADARR_FILTER_MODES : FILTER_MODES;
    if (!allowed.includes(mode)) return;
    if (lastSettings) lastSettings[key] = mode;
    chrome.storage.local.set({ [key]: mode });
    scanPosters();
  }

  function buildFilterGroup(dimension, label, icon, buttons) {
    const wrap = document.createElement('div');
    wrap.className = 'reelhop-filter-dim';
    wrap.dataset.dimension = dimension;
    wrap.appendChild(icon);

    const group = document.createElement('div');
    group.className = 'reelhop-filter-group';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', label);
    for (const [mode, text] of buttons) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'reelhop-filter-btn';
      btn.dataset.mode = mode;
      const name = document.createElement('span');
      name.textContent = text;
      btn.appendChild(name);
      const count = document.createElement('span');
      count.className = 'reelhop-filter-count';
      btn.appendChild(count);
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        setPosterFilter(dimension, mode);
      });
      group.appendChild(btn);
    }
    wrap.appendChild(group);
    return wrap;
  }

  function createFilterBar() {
    const bar = document.createElement('div');
    bar.id = FILTER_BAR_ID;
    bar.className = `reelhop-poster-filter ${INJECTED_CLASS}`;

    bar.appendChild(buildFilterGroup('plex', 'Filter this grid by what is on Plex', createPlexIcon(),
      [['all', 'All'], ['available', 'On Plex'], ['unavailable', 'Not on Plex']]));
    bar.appendChild(buildFilterGroup('radarr', 'Filter this grid by what is in Radarr', createRadarrIcon(),
      [['all', 'All'], ['in', 'In Radarr'], ['out', 'Not in Radarr']]));

    const status = document.createElement('span');
    status.className = 'reelhop-filter-status';
    bar.appendChild(status);

    // Adds every film currently shown that isn't in Radarr. Two steps, because
    // one careless click could queue a whole page.
    const bulk = document.createElement('button');
    bulk.type = 'button';
    bulk.className = 'reelhop-filter-bulk';
    bulk.hidden = true;
    bulk.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onBulkAddClick();
    });
    bar.appendChild(bulk);

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'reelhop-filter-cancel';
    cancel.textContent = 'Cancel';
    cancel.hidden = true;
    cancel.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      bulkArmed = false;
      scanPosters();
    });
    bar.appendChild(cancel);

    // Only shown when the current filter leaves the grid empty, so there is
    // always a way back from a blank page.
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'reelhop-filter-reset';
    reset.textContent = 'Show all';
    reset.hidden = true;
    reset.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      setPosterFilter('radarr', 'all');
      setPosterFilter('plex', 'all');
    });
    bar.appendChild(reset);
    return bar;
  }

  // Which posters a bulk add would act on: shown, and offering a "+".
  function bulkAddTargets(settings, grid) {
    if (!grid || !radarrCanAdd || !posterWants(settings).radarr) return [];
    const modes = currentModes(settings);
    return gridPosters(grid)
      .filter(p => !posterHidden(modes, p))
      .filter(p => {
        const state = radarrPoster.get(p.slug);
        return state && (state.status === 'add' || state.status === 'error');
      });
  }

  // Place (or remove) the bar and bring its labels up to date.
  function syncFilterBar(settings, grid) {
    let bar = document.getElementById(FILTER_BAR_ID);
    if (!grid || !settings.showPosterFilter) {
      if (bar) bar.remove();
      return;
    }
    if (!bar) {
      bar = createFilterBar();
      // Sit above the whole grid block, which is wrapped differently on browse
      // pages than on lists and watchlists.
      const anchor = grid.closest('.poster-grid, .productions-browser-list') || grid;
      anchor.parentNode.insertBefore(bar, anchor);
    }

    const modes = currentModes(settings);
    const counts = gridCounts(gridPosters(grid), modes);
    const showRadarr = posterWants(settings).radarr;

    for (const dim of bar.querySelectorAll('.reelhop-filter-dim')) {
      const dimension = dim.dataset.dimension;
      if (dimension === 'radarr') dim.hidden = !showRadarr;
      const active = modes[dimension];
      for (const btn of dim.querySelectorAll('.reelhop-filter-btn')) {
        const isActive = btn.dataset.mode === active;
        btn.classList.toggle('is-active', isActive);
        btn.setAttribute('aria-pressed', String(isActive));
        // Counts only mean something once every poster has an answer.
        const text = counts.pending > 0 ? '' : String(counts[dimension][btn.dataset.mode]);
        const count = btn.querySelector('.reelhop-filter-count');
        if (count.textContent !== text) count.textContent = text;
      }
    }

    const empty = counts.pending === 0 && counts.total > 0 && counts.visible === 0;
    const filtered = modes.plex !== 'all' || modes.radarr !== 'all';

    const status = bar.querySelector('.reelhop-filter-status');
    let note = '';
    if (counts.pending > 0) note = 'Checking…';
    else if (bulkState.running) note = `Adding ${bulkState.done + 1} of ${bulkState.total}…`;
    else if (bulkState.report) note = bulkState.report;
    else if (radarrPosterProblem) note = radarrPosterProblem;
    else if (empty) note = 'Nothing on this page matches.';
    else if (filtered) note = `Showing ${counts.visible} of ${counts.total}`;
    if (status.textContent !== note) status.textContent = note;
    status.classList.toggle('is-empty', empty);

    syncBulkButton(bar, settings, grid);

    const reset = bar.querySelector('.reelhop-filter-reset');
    if (reset.hidden !== !empty) reset.hidden = !empty;
  }

  function syncBulkButton(bar, settings, grid) {
    const bulk = bar.querySelector('.reelhop-filter-bulk');
    const cancel = bar.querySelector('.reelhop-filter-cancel');
    const targets = bulkAddTargets(settings, grid);

    if (bulkState.running) {
      bulk.hidden = false;
      bulk.disabled = true;
      bulk.textContent = 'Adding…';
      bulk.className = 'reelhop-filter-bulk is-busy';
      cancel.hidden = true;
      return;
    }
    bulk.disabled = false;
    if (targets.length === 0) {
      bulk.hidden = true;
      cancel.hidden = true;
      bulkArmed = false;
      return;
    }
    bulk.hidden = false;
    const noun = `${targets.length} film${targets.length === 1 ? '' : 's'}`;
    bulk.textContent = bulkArmed ? `Add ${noun}?` : `Add ${noun} to Radarr`;
    bulk.className = `reelhop-filter-bulk${bulkArmed ? ' is-armed' : ''}`;
    bulk.title = bulkArmed
      ? 'Click again to add every film shown that is not in Radarr'
      : `Add the ${noun} shown here that are not in Radarr`;
    cancel.hidden = !bulkArmed;
  }

  function onBulkAddClick() {
    if (bulkState.running || !lastSettings) return;
    if (!bulkArmed) {
      bulkArmed = true;
      scanPosters();
      return;
    }
    bulkArmed = false;
    runBulkAdd();
  }

  // Add the shown films one at a time. Sequential on purpose: Radarr does a
  // remote lookup per add, and a page of them at once is a burst it doesn't
  // need. Each poster's "+" updates as its turn comes.
  async function runBulkAdd() {
    const grid = mainPosterGrid();
    const targets = bulkAddTargets(lastSettings, grid);
    if (targets.length === 0) return;

    bulkState = { running: true, done: 0, total: targets.length, added: 0, failed: 0, report: '' };
    scanPosters();

    for (const target of targets) {
      await addPosterToRadarr(target.el);
      const state = radarrPoster.get(target.slug);
      if (state && state.status === 'added') bulkState.added++;
      else bulkState.failed++;
      bulkState.done++;
      scanPosters();
    }

    const parts = [`Added ${bulkState.added}`];
    if (bulkState.failed > 0) parts.push(`${bulkState.failed} failed`);
    bulkState = { running: false, done: 0, total: 0, added: 0, failed: 0, report: parts.join(', ') };
    scanPosters();
    setTimeout(() => {
      bulkState.report = '';
      scanPosters();
    }, 6000);
  }

  // Hide the grid items the current modes exclude. A poster we haven't heard
  // back about yet stays visible: better a late change than a wrong one.
  function applyPosterFilter(settings, grid) {
    const modes = grid && settings.showPosterFilter
      ? currentModes(settings)
      : { plex: 'all', radarr: 'all' };
    const inGrid = new Map(grid ? gridPosters(grid).map(p => [p.el, p]) : []);
    for (const el of document.querySelectorAll(POSTER_SELECTOR)) {
      const poster = inGrid.get(el);
      const hide = !!poster && posterHidden(modes, poster);
      (el.closest('li') || el).classList.toggle(FILTER_HIDDEN_CLASS, hide);
    }
  }

  // Forget everything and strip the marks; the next scan starts over.
  function resetPosters() {
    radarrPosterProblem = '';
    radarrInLibrary.clear();
    bulkArmed = false;
    posterResults.clear();
    radarrPoster.clear();
    posterKnown.clear();
    posterPending.clear();
    posterQueue = new Map();
    document.querySelectorAll(`.${POSTER_MARKS_CLASS}`).forEach((el) => el.remove());
    document.querySelectorAll('[data-reelhop-poster]').forEach((el) => { delete el.dataset.reelhopPoster; });
    document.getElementById(FILTER_BAR_ID)?.remove();
    document.querySelectorAll(`.${FILTER_HIDDEN_CLASS}`).forEach((el) => el.classList.remove(FILTER_HIDDEN_CLASS));
  }

  // Paint known posters, queue unknown ones. Cheap enough to run after every
  // (debounced) DOM mutation: Letterboxd swaps poster nodes as images load.
  async function scanPosters() {
    if (!isLetterboxd()) return;
    const settings = lastSettings || await getSettings();
    const wants = posterWants(settings);
    if (!wants.plex && !wants.radarr) {
      resetPosters();
      return;
    }
    const adapter = getActiveAdapter();
    const ownSlug = adapter && adapter.id === 'letterboxd' ? adapter.getKey() : '';

    for (const el of document.querySelectorAll(POSTER_SELECTOR)) {
      const slug = el.dataset.itemSlug;
      if (!slug || slug === ownSlug) continue;
      const width = posterWidth(el);
      if (width < POSTER_MIN_WIDTH || width > POSTER_MAX_WIDTH) continue;
      if (posterKnown.has(slug)) {
        paintPoster(el, posterView(slug, wants), settings);
      } else if (!posterPending.has(slug)) {
        const film = posterFilm(el);
        if (!film.title) continue;
        posterPending.add(slug);
        posterQueue.set(slug, film);
      }
    }
    if (posterQueue.size > 0 && !posterFlushTimer) {
      posterFlushTimer = setTimeout(() => flushPosterQueue(settings), 150);
    }

    const grid = wants.plex ? mainPosterGrid() : null;
    syncFilterBar(settings, grid);
    applyPosterFilter(settings, grid);
  }

  // One round trip per destination for the whole batch, in parallel.
  async function flushPosterQueue(settings) {
    posterFlushTimer = null;
    const batch = posterQueue;
    posterQueue = new Map();
    if (batch.size === 0) return;

    const wants = posterWants(settings);
    const keys = [...batch.keys()];
    const films = [...batch].map(([key, film]) => ({ key, title: film.title, year: film.year }));
    const ask = async (action) => {
      try {
        return await chrome.runtime.sendMessage({ action, films });
      } catch (e) {
        console.warn(`[ReelHop] ${action} failed:`, e);
        return null;
      }
    };

    const [cached, plexRes, radarrRes] = await Promise.all([
      // Film pages already resolved some of these (7-day cache); a server hit
      // there counts here too, so a title Plex spells differently keeps its chip.
      wants.plex ? getCachedResults('letterboxd', keys) : Promise.resolve({}),
      wants.plex ? ask('plexLibraryMatch') : Promise.resolve(null),
      wants.radarr ? ask('radarrLibraryMatch') : Promise.resolve(null)
    ]);

    if (wants.radarr) {
      radarrCanAdd = !!(radarrRes && radarrRes.ok && radarrRes.canAdd === true);
      radarrPosterProblem = radarrRes && radarrRes.ok ? '' : radarrPosterMessage(radarrRes);
    }

    for (const key of keys) {
      if (wants.plex) {
        let match = plexRes && plexRes.ok ? plexRes.matches[key] || null : null;
        const c = cached[key];
        if (!match && c && c.type === 'server') match = { type: 'server', url: c.url, serverName: c.serverName };
        posterResults.set(key, match);
      }
      if (wants.radarr) {
        // A Radarr that can't be reached stays quiet on the posters themselves
        // rather than stamping an error on every one; the filter bar says why
        // once, and the film-page button reports the detail.
        if (!radarrRes || !radarrRes.ok) {
          radarrPoster.set(key, null);
        } else if (radarrRes.matches[key]) {
          radarrPoster.set(key, null); // already in Radarr
          radarrInLibrary.add(key);
        } else {
          radarrPoster.set(key, { status: 'add', url: radarrCanAdd ? null : addPageUrl(radarrRes, batch.get(key)) });
        }
      }
      posterPending.delete(key);
      posterKnown.add(key);
    }
    scanPosters();
  }

  // Why no "+" buttons appeared. Said once in the filter bar rather than
  // stamped on every poster, and only for problems the user can act on.
  function radarrPosterMessage(res) {
    switch (res && res.reason) {
      case 'unauthorized': return 'Radarr rejected its API key.';
      case 'permission': return 'Radarr needs browser access.';
      case 'unconfigured': return 'Radarr needs an API key.';
      case 'disabled': return '';
      case undefined: return 'Radarr did not answer.';
      default: return 'Radarr could not be reached.';
    }
  }

  // Where the "+" points when it can't add in place (no profile / root folder).
  function addPageUrl(radarrRes, film) {
    const term = film.year ? `${film.title} ${film.year}` : film.title;
    return `${radarrRes.addUrlBase}${encodeURIComponent(term)}`;
  }

  // One-click add from a poster. The worker re-checks Radarr before posting,
  // so a stale "+" on a film that is already there reports itself as added.
  async function addPosterToRadarr(el) {
    const slug = el.dataset.itemSlug;
    const film = posterFilm(el);
    if (!slug || !film.title || !lastSettings) return;
    const state = radarrPoster.get(slug);
    if (!state || (state.status !== 'add' && state.status !== 'error')) return;

    radarrPoster.set(slug, { status: 'adding', url: state.url });
    scanPosters();

    let result;
    try {
      result = await chrome.runtime.sendMessage({ action: 'radarrAdd', movie: { title: film.title, year: film.year } });
    } catch (e) {
      result = { error: e.message };
    }

    if (result && result.status === 'in_library') {
      radarrPoster.set(slug, { status: 'added', url: result.url || state.url });
      // Deliberately not added to radarrInLibrary: a film shouldn't vanish
      // from under the cursor the moment it is added. The next page load
      // re-asks Radarr and files it correctly.
    } else {
      const message = (result && (result.message || result.error)) ||
        (result && result.status === 'not_found' ? 'Radarr could not find this film' : 'Radarr could not add this film');
      radarrPoster.set(slug, { status: 'error', url: result && result.url ? result.url : state.url, message });
    }
    scanPosters();
  }

  // The "+" is an anchor so middle-click still opens Radarr, but a plain click
  // adds in place when we have everything Radarr needs.
  function onPosterClick(e) {
    const plus = e.target && e.target.closest ? e.target.closest(`.${POSTER_ADD_CLASS}`) : null;
    if (!plus) return;
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const status = plus.dataset.status;
    if (status === 'adding' || status === 'added') {
      if (!plus.getAttribute('href')) e.preventDefault();
      return;
    }
    if (!radarrCanAdd) return; // let the anchor open Radarr's add page
    const el = plus.closest(POSTER_SELECTOR);
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    addPosterToRadarr(el);
  }

  function schedulePosterScan() {
    if (!isLetterboxd() || posterScanTimer) return;
    posterScanTimer = setTimeout(() => {
      posterScanTimer = null;
      scanPosters();
    }, 250);
  }

  // ---------------------------------------------------------------------------
  // Engine
  // ---------------------------------------------------------------------------

  function currentFilmToken() {
    const adapter = getActiveAdapter();
    return adapter ? `${adapter.id}|${adapter.getKey()}` : null;
  }

  // Radarr manages movies, Sonarr manages shows. A title with an unknown type
  // is treated as a film, which is what Letterboxd and most IMDb pages are.
  function libraryDestination(settings, movie) {
    if (movie.type === 'show') {
      return settings.sonarrEnabled && settings.sonarrUrl ? 'sonarr' : null;
    }
    return settings.radarrEnabled && settings.radarrUrl ? 'radarr' : null;
  }

  function libraryUrlFor(settings, destination) {
    return destination === 'sonarr' ? settings.sonarrUrl : settings.radarrUrl;
  }

  function libraryStateFrom(result, filmToken, settings, destination) {
    const url = libraryUrlFor(settings, destination);
    if (!result || result.error) {
      return { token: filmToken, destination, status: 'unreachable', url, message: result && result.error };
    }
    return { token: filmToken, destination, ...result, url: result.url || url };
  }

  // Repaint whatever buttons are on the page from the stored states — but only
  // if they still describe the film on screen.
  function applyDisplayState(token) {
    if (displayState && displayState.token === token) {
      updateAllPlexLinks(displayState.url, displayState.type, displayState.serverName);
    }
    if (libraryState && libraryState.token === token) {
      document.querySelectorAll(`.${RADARR_CLASS}`).forEach((a) => paintRadarrButton(a, libraryState));
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
      radarr: libraryState && libraryState.token === token ? libraryState : null
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
    const destination = libraryDestination(settings, movie);
    if (!destination) {
      libraryState = null;
    } else if (!libraryState || libraryState.token !== filmToken) {
      libraryState = libraryMemo.get(filmToken) ||
                    { token: filmToken, destination, status: 'checking', url: libraryUrlFor(settings, destination) };
    }

    adapter.inject({ plex: displayState, radarr: libraryState }, settings);
    applyDisplayState(filmToken);

    // Resolve each destination in the background worker, in parallel.
    const jobs = [];
    if (!cached && settings.plexToken && !isResolvingPlex) {
      jobs.push(resolvePlex(adapter, movie, filmKey, filmToken, plexUrl));
    }
    if (libraryState && libraryState.status === 'checking' && !isResolvingLibrary) {
      jobs.push(resolveLibrary(movie, filmToken, settings, destination));
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

  async function resolveLibrary(movie, filmToken, settings, destination) {
    isResolvingLibrary = true;
    try {
      const result = await chrome.runtime.sendMessage({ action: `${destination}Resolve`, movie });
      if (currentFilmToken() === filmToken) {
        if (result && result.status === 'disabled') {
          libraryState = null;
        } else {
          libraryState = libraryStateFrom(result, filmToken, settings, destination);
          if (['in_library', 'missing', 'not_found'].includes(libraryState.status)) {
            libraryMemo.set(filmToken, { ...libraryState, at: Date.now() });
          }
        }
      }
    } catch (e) {
      console.warn('[ReelHop] Radarr resolve failed:', e);
      if (currentFilmToken() === filmToken) {
        libraryState = { token: filmToken, destination, status: 'unreachable', url: libraryUrlFor(settings, destination), message: e.message };
      }
    } finally {
      isResolvingLibrary = false;
      renderCurrent();
      if (currentFilmToken() !== filmToken) scheduleInject();
    }
  }

  // One-click add, triggered from a library button in the 'missing' state.
  async function addToLibrary() {
    const adapter = getActiveAdapter();
    if (!adapter || !lastSettings) return;
    const movie = adapter.extract();
    const filmToken = currentFilmToken();
    if (!movie || !libraryState || libraryState.token !== filmToken || libraryState.status !== 'missing') return;

    libraryState = { ...libraryState, status: 'adding' };
    applyDisplayState(filmToken);

    const destination = libraryState.destination || 'radarr';
    let result;
    try {
      result = await chrome.runtime.sendMessage({ action: `${destination}Add`, movie });
    } catch (e) {
      result = { error: e.message };
    }
    if (currentFilmToken() !== filmToken) return;

    libraryState = libraryStateFrom(result, filmToken, lastSettings, destination);
    if (libraryState.status === 'in_library') {
      libraryMemo.set(filmToken, { ...libraryState, at: Date.now() });
    } else {
      libraryMemo.delete(filmToken);
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
    if (status === 'missing' && libraryState && libraryState.canAdd) {
      e.preventDefault();
      e.stopPropagation();
      addToLibrary();
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
      schedulePosterScan();
    }
  }

  function init() {
    currentUrl = location.href;
    if (getActiveAdapter()) injectLinks();
    scanPosters();

    const observer = new MutationObserver(() => {
      handleUrlChange();
      // Sites re-render dynamically; re-inject if our nodes were wiped, but
      // skip the work when everything expected is already present.
      if (getActiveAdapter() && !allLinksInjected()) {
        scheduleInject();
      }
      schedulePosterScan();
    });

    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener('click', onDocumentClick, true);
    document.addEventListener('click', onPosterClick, true);
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      // Radarr settings changed: forget what we knew and ask again.
      if (Object.keys(changes).some(k => k.startsWith('radarr') || k.startsWith('sonarr'))) {
        libraryMemo.clear();
        libraryState = null;
      }
      // Token or chip settings changed: the chips describe a different world.
      if (POSTER_RESET_KEYS.some(k => k in changes)) {
        getSettings().then(() => { resetPosters(); scanPosters(); });
      } else if (POSTER_REFRESH_KEYS.some(k => k in changes)) {
        getSettings().then(() => scanPosters());
      }
      scheduleInject();
    });
    // A tab left open while Radarr finishes a download would otherwise keep
    // saying "Wanted". When the tab comes back into view and the answer is
    // old, ask again; the button repaints only once Radarr replies.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || isResolvingLibrary || !lastSettings) return;
      const token = currentFilmToken();
      const memo = libraryMemo.get(token);
      if (!memo || Date.now() - (memo.at || 0) < RADARR_RECHECK_MS) return;
      const adapter = getActiveAdapter();
      const movie = adapter && adapter.isFilmPage() ? adapter.extract() : null;
      const destination = movie && libraryDestination(lastSettings, movie);
      if (destination) resolveLibrary(movie, token, lastSettings, destination);
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
