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

  // Best entry for one film: exact normalized title (or original title), year
  // within one, preferring the exact year and a title over an original-title
  // hit. With no year to go on, only an unambiguous title counts — a wrong
  // match is worse than none.
  function matchLibraryEntry(index, film) {
    const title = normalize(film && film.title);
    if (!title || !index || !index.byTitle) return null;
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

  // What a Radarr film-page button should say. `tone` picks the chip colour.
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

  // Split a grid's posters by what is known about each. `lookup` returns the
  // Plex answer for a slug; `known` says whether it has been answered at all.
  function filterTally(slugs, lookup, known) {
    const tally = { total: 0, available: 0, unavailable: 0, pending: 0 };
    for (const slug of slugs) {
      tally.total++;
      if (!known(slug)) tally.pending++;
      else if (lookup(slug)) tally.available++;
      else tally.unavailable++;
    }
    return tally;
  }

  root.ReelHop = {
    sanitizeText,
    normalize,
    yearsClose,
    parseTitleYear,
    indexByTitle,
    matchLibraryEntry,
    normalizeRadarrUrl,
    radarrOriginPattern,
    radarrHasFile,
    badgeLabelFor,
    radarrView,
    posterAddView,
    posterSizeClass,
    filterHides,
    filterTally
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
