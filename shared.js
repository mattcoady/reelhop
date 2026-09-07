// ReelHop - Shared pure helpers
//
// Everything here is a pure function: no DOM, no chrome APIs, no network. That
// is what lets all three sides of the extension load the same copy —
//
//   background.js   importScripts('shared.js')
//   content.js      listed before it in manifest content_scripts[].js
//   options.html    a plain <script> before options.js
//
// — and lets test/shared.test.js exercise the logic that used to be locked
// inside a content script. Anything that touches a page, storage or the
// network belongs in the file that owns it, not here.
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Text
  // ---------------------------------------------------------------------------

  // Collapse the exotic whitespace film titles pick up (Letterboxd and IMDb
  // both use non-breaking and hair spaces) into ordinary single spaces.
  function sanitizeText(str) {
    if (!str) return '';
    return String(str)
      .replace(/[\u00A0\u1680\u180e\u2000-\u200b\u202f\u205f\u3000\ufeff]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // The form titles are compared in: lowercase, letters and digits only. It
  // makes "WALL·E" and "Wall-E", or "Se7en" and "Se7en ", the same string.
  function normalize(str) {
    return sanitizeText(str)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  }

  // Release years disagree across sources by a year all the time (festival vs.
  // general release), so treat neighbours as equal. A missing year matches
  // anything: the caller decides whether that is good enough.
  function yearsClose(a, b) {
    const ya = parseInt(a, 10);
    const yb = parseInt(b, 10);
    return !ya || !yb || Math.abs(ya - yb) <= 1;
  }

  // "Title (Year)" -> { title, year }, tolerating the "Poster for ..." prefix
  // Letterboxd puts in image alt text. The lazy group means a title that is
  // itself a year ("1917 (2019)") still splits correctly.
  function parseTitleYear(raw) {
    const name = sanitizeText(raw).replace(/^Poster for\s+/i, '');
    const m = name.match(/^(.*?)\s*\((\d{4})\)$/);
    return m ? { title: m[1], year: m[2] } : { title: name, year: '' };
  }

  // ---------------------------------------------------------------------------
  // Library matching
  //
  // Both the Plex and Radarr indexes are lists of entries shaped
  // { t: normalized title, o: normalized original title (optional), y: year }
  // plus whatever else that destination needs. These two functions are the
  // whole matching story.
  // ---------------------------------------------------------------------------

  function indexByTitle(entries) {
    const byTitle = new Map();
    const add = (key, entry) => {
      const list = byTitle.get(key);
      if (list) list.push(entry); else byTitle.set(key, [entry]);
    };
    for (const entry of entries || []) {
      add(entry.t, entry);
      if (entry.o) add(entry.o, entry);
    }
    return byTitle;
  }

  // Entries that carry an IMDb id (`i`), keyed by it. An id beats any amount
  // of title cleverness, and IMDb's own pages hand us one for every poster.
  function indexByImdb(entries) {
    const byImdb = new Map();
    for (const entry of entries || []) {
      if (entry.i && !byImdb.has(entry.i)) byImdb.set(entry.i, entry);
    }
    return byImdb;
  }

  // Best entry for one film: exact normalized title (or original title), year
  // within one, preferring the exact year and a title over an original-title
  // hit. With no year to go on, only an unambiguous title counts — a wrong
  // match is worse than none.
  function matchLibraryEntry(index, film) {
    if (!index || !film) return null;
    // An IMDb id is exact; try it before anything else.
    if (film.imdbId && index.byImdb) {
      const byId = index.byImdb.get(film.imdbId);
      if (byId) return byId;
    }
    const title = normalize(film.title);
    if (!title || !index.byTitle) return null;
    const candidates = index.byTitle.get(title);
    if (!candidates || candidates.length === 0) return null;

    const year = parseInt(film.year, 10) || 0;
    if (!year) {
      const years = new Set(candidates.map(c => c.y));
      return years.size === 1 ? candidates[0] : null;
    }

    let best = null;
    let bestScore = -1;
    for (const c of candidates) {
      if (!yearsClose(c.y, year)) continue;
      const score = (c.y === year ? 4 : 0) + (c.t === title ? 2 : 1);
      if (score > bestScore) { best = c; bestScore = score; }
    }
    return best;
  }

  // ---------------------------------------------------------------------------
  // Radarr
  // ---------------------------------------------------------------------------

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

  // Radarr v5 stopped filling in MovieResource.hasFile (it is a nullable
  // "compatibility" field that ToResource never assigns), so a downloaded movie
  // arrives with hasFile null and movieFileId > 0. Trust any of the signals.
  function radarrHasFile(movie) {
    if (!movie) return false;
    if (movie.hasFile === true) return true;
    if (typeof movie.movieFileId === 'number' && movie.movieFileId > 0) return true;
    return !!(movie.movieFile && movie.movieFile.id > 0);
  }

  // ---------------------------------------------------------------------------
  // Button and badge wording
  //
  // State in, words out. Kept here so the labels can be tested without a page.
  // ---------------------------------------------------------------------------

  function badgeLabelFor(type) {
    if (type === 'checking') return 'Checking…';
    if (type === 'server') return 'On Server';
    if (type === 'discover') return 'Discover';
    return 'Search';
  }

  // What a library button should say. Radarr manages movies and Sonarr manages
  // shows, but a title is only ever one of the two, so a film page has a single
  // button and this decides which service it is talking about. `tone` picks the
  // chip colour.
  function libraryView(state) {
    const s = state || { status: 'checking' };
    const show = s.destination === 'sonarr';
    const app = show ? 'Sonarr' : 'Radarr';
    const item = show ? 'series' : 'movie';

    switch (s.status) {
      case 'checking':
        return { label: app, badge: 'Checking…', tone: 'checking', title: `Checking ${app}…` };
      case 'adding':
        return { label: `Add to ${app}`, badge: 'Adding…', tone: 'checking', title: `Adding to ${app}…` };
      case 'in_library': {
        // Sonarr counts episodes, so a series can be half here.
        const badge = s.justAdded ? 'Added'
          : s.hasFile ? 'Downloaded'
          : s.partial ? 'Partial'
          : s.monitored ? 'Wanted'
          : 'Unmonitored';
        const tone = (s.justAdded || s.hasFile) ? 'ok'
          : (s.partial || s.monitored) ? 'warn'
          : 'neutral';
        const detail = s.partial && s.episodeCount
          ? `${s.episodeFileCount} of ${s.episodeCount} episodes`
          : badge.toLowerCase();
        return { label: `Open in ${app}`, badge, tone, title: `In your ${app} library (${detail})` };
      }
      case 'missing':
        return s.canAdd
          ? { label: `Add to ${app}`, badge: 'Add', tone: 'action', title: `Add this ${item} to ${app} with your default profile and root folder` }
          : { label: `Add in ${app}`, badge: 'Not added', tone: 'neutral', title: `Open ${app} to add this ${item}` };
      case 'not_found':
        return { label: `Search in ${app}`, badge: 'Not found', tone: 'neutral', title: `${app} could not match this title; opens a ${app} search` };
      case 'unauthorized':
        return { label: app, badge: 'Bad API key', tone: 'err', title: `${app} rejected the API key. Check ReelHop settings.` };
      case 'permission':
        return { label: app, badge: 'Needs access', tone: 'err', title: `Open ReelHop settings and press Connect to grant access to your ${app} URL.` };
      case 'unconfigured':
        return { label: app, badge: 'Setup', tone: 'err', title: s.message || `Finish ${app} setup in ReelHop settings.` };
      case 'error':
        return { label: app, badge: 'Failed', tone: 'err', title: s.message || `${app} returned an error` };
      default:
        return { label: app, badge: 'Unreachable', tone: 'err', title: s.message ? `${app}: ${s.message}` : `Could not reach ${app}` };
    }
  }

  // What the "+" on a poster says. Only films that aren't in Radarr get one,
  // so the resting state is always the offer to add.
  function posterAddView(state, canAdd) {
    switch (state && state.status) {
      case 'adding': return { icon: '…', label: 'Adding to Radarr…', tone: 'busy' };
      case 'added': return { icon: '✓', label: 'Added to Radarr', tone: 'ok' };
      case 'error': return { icon: '!', label: (state && state.message) || 'Radarr could not add this', tone: 'err' };
      default: return {
        icon: '+',
        label: canAdd ? 'Add to Radarr' : 'Open this in Radarr to add it',
        tone: 'action'
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Poster grids
  // ---------------------------------------------------------------------------

  // Which size of chip a poster of this width should carry.
  function posterSizeClass(width) {
    if (width < 100) return '-sm';
    if (width > 160) return '-lg';
    return '';
  }

  // Should the availability filter hide this poster? `match` is the Plex
  // answer: an object when the film is on a server, null when it isn't, and
  // undefined while we are still waiting — and something unanswered is never
  // hidden, because a late change beats a wrong one.
  function filterHides(mode, match) {
    if (mode !== 'available' && mode !== 'unavailable') return false;
    if (match === undefined) return false;
    return mode === 'available' ? !match : !!match;
  }

  // Should the Radarr half of the filter hide this poster? `inLibrary` is true
  // when the film is already in Radarr, false when it isn't, and undefined
  // while we are still waiting — and again, unanswered is never hidden.
  function radarrFilterHides(mode, inLibrary) {
    if (mode !== 'in' && mode !== 'out') return false;
    if (inLibrary === undefined) return false;
    return mode === 'in' ? !inLibrary : !!inLibrary;
  }

  // A poster survives only if both halves of the filter let it through.
  function posterHidden(modes, poster) {
    return filterHides(modes.plex, poster.plex) ||
           radarrFilterHides(modes.radarr, poster.radarr);
  }

  function countVisible(posters, plexMode, radarrMode) {
    const modes = { plex: plexMode, radarr: radarrMode };
    let n = 0;
    for (const p of posters) if (!posterHidden(modes, p)) n++;
    return n;
  }

  // Everything the filter bar needs to label itself. Each button's count is
  // what you would actually see after clicking it, so the other half of the
  // filter is held at its current setting rather than ignored.
  //
  // posters: [{ plex, radarr, known }] — plex is the Plex answer (object when
  // on a server, null when not, undefined when unanswered), radarr is true /
  // false / undefined for "already in Radarr".
  function gridCounts(posters, modes) {
    return {
      total: posters.length,
      pending: posters.filter(p => !p.known).length,
      visible: countVisible(posters, modes.plex, modes.radarr),
      plex: {
        all: countVisible(posters, 'all', modes.radarr),
        available: countVisible(posters, 'available', modes.radarr),
        unavailable: countVisible(posters, 'unavailable', modes.radarr)
      },
      radarr: {
        all: countVisible(posters, modes.plex, 'all'),
        in: countVisible(posters, modes.plex, 'in'),
        out: countVisible(posters, modes.plex, 'out')
      }
    };
  }

  root.ReelHop = {
    sanitizeText,
    normalize,
    yearsClose,
    parseTitleYear,
    indexByTitle,
    indexByImdb,
    matchLibraryEntry,
    normalizeRadarrUrl,
    radarrOriginPattern,
    radarrHasFile,
    badgeLabelFor,
    libraryView,
    posterAddView,
    posterSizeClass,
    filterHides,
    radarrFilterHides,
    posterHidden,
    countVisible,
    gridCounts
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
