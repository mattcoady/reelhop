// Tests for shared.js, run with:  node test/shared.test.js
//
// shared.js is the pure half of the extension — text handling, library
// matching, URL normalization, and every piece of button wording. None of it
// touches a page, storage or the network, so it can be tested directly. This
// is where the content script's logic is covered; content.js itself is now
// only the DOM plumbing around these functions.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ctx = { URL, Map, Set, JSON, Math, console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'shared.js'), 'utf8'), ctx, { filename: 'shared.js' });
const R = ctx.ReelHop;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}
const eq = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });

// =============================================================================
console.log('sanitizeText');
eq('collapses runs of whitespace', R.sanitizeText('  The   Zone  of Interest '), 'The Zone of Interest');
eq('replaces non-breaking and hair spaces', R.sanitizeText('Amélie (2001)'), 'Amélie (2001)');
eq('strips a zero-width joiner', R.sanitizeText('Se7en​'), 'Se7en');
eq('empty input stays empty', R.sanitizeText(''), '');
eq('null input stays empty', R.sanitizeText(null), '');
eq('a number is still text', R.sanitizeText(1917), '1917');

console.log('normalize');
eq('case and punctuation fall away', R.normalize('WALL·E'), 'walle');
check('two spellings of the same title agree', R.normalize('WALL·E') === R.normalize('Wall-E'));
check('a colon does not change a title', R.normalize('Dune: Part Two') === R.normalize('Dune Part Two'));
check('an apostrophe does not change a title', R.normalize("L'Atalante") === R.normalize('LAtalante'));
eq('digits survive', R.normalize('Se7en'), 'se7en');
eq('accents are dropped, not transliterated', R.normalize('Amélie'), 'amlie');
eq('a title of only punctuation normalizes to nothing', R.normalize('!!!'), '');

console.log('yearsClose');
check('the same year matches', R.yearsClose(2010, 2010));
check('one year apart matches (festival vs. release)', R.yearsClose(2023, 2024));
check('two years apart does not', !R.yearsClose(2020, 2022));
check('a missing year matches anything', R.yearsClose(0, 1994) && R.yearsClose(1994, undefined));
check('strings are accepted', R.yearsClose('2010', 2011));

console.log('parseTitleYear');
eq('splits title and year', R.parseTitleYear('Barbie (2023)'), { title: 'Barbie', year: '2023' });
eq('drops the "Poster for" prefix', R.parseTitleYear('Poster for Past Lives (2023)'), { title: 'Past Lives', year: '2023' });
eq('a title that is a year still splits', R.parseTitleYear('1917 (2019)'), { title: '1917', year: '2019' });
eq('a title ending in a number keeps it', R.parseTitleYear('Blade Runner 2049 (2017)'), { title: 'Blade Runner 2049', year: '2017' });
eq('parentheses inside a title survive', R.parseTitleYear('Kill Bill: Vol. 1 (2003)'), { title: 'Kill Bill: Vol. 1', year: '2003' });
eq('no year -> empty year, whole string as title', R.parseTitleYear('Untitled Project'), { title: 'Untitled Project', year: '' });
eq('a trailing non-year in brackets is part of the title', R.parseTitleYear('Movie (Director’s Cut)'), { title: 'Movie (Director’s Cut)', year: '' });
eq('empty input is handled', R.parseTitleYear(''), { title: '', year: '' });

// =============================================================================
console.log('library matching');
const entries = [
  { t: 'inception', y: 2010, k: '901' },
  { t: 'playtime', o: 'playtime2', y: 1967, k: '903' },
  { t: 'thething', y: 1982, k: '904' },
  { t: 'thething', y: 2011, k: '905' },
  { t: 'duneparttwo', y: 2023, k: '906' },
  { t: 'severance', y: 2022, k: '950' }
];
const index = { byTitle: R.indexByTitle(entries) };
const find = (title, year) => R.matchLibraryEntry(index, { title, year });

check('indexes originals under their own key', index.byTitle.has('playtime2'), [...index.byTitle.keys()]);
check('same title twice shares one bucket', index.byTitle.get('thething').length === 2);
eq('an exact title and year match', find('Inception', '2010').k, '901');
eq('punctuation is ignored when matching', find('Dune: Part Two', '2023').k, '906');
eq('a year one off still matches', find('Dune: Part Two', '2024').k, '906');
eq('a year three off does not', find('Inception', 2013), null);
eq('an original title matches', find('Play Time', '1967').k, '903');
eq('the right year wins among duplicates', find('The Thing', '2011').k, '905');
eq('the other year wins for the other film', find('The Thing', '1982').k, '904');
eq('an ambiguous title with no year gets no guess', find('The Thing', ''), null);
eq('an unambiguous title with no year is matched', find('Inception', '').k, '901');
eq('a title that is not there matches nothing', find('The Holdovers', '2023'), null);
eq('an empty title matches nothing', find('', '1982'), null);
eq('an empty index matches nothing', R.matchLibraryEntry({ byTitle: new Map() }, { title: 'Inception', year: '2010' }), null);
eq('a missing index is handled', R.matchLibraryEntry(null, { title: 'Inception' }), null);
eq('a missing film is handled', R.matchLibraryEntry(index, null), null);

// An exact-year hit must beat a near-year hit even when the near one comes first.
const closeIndex = { byTitle: R.indexByTitle([{ t: 'x', y: 1999, k: 'near' }, { t: 'x', y: 2000, k: 'exact' }]) };
eq('an exact year beats a neighbouring one', R.matchLibraryEntry(closeIndex, { title: 'x', year: '2000' }).k, 'exact');
// A title hit must beat an original-title hit at the same year.
const bothIndex = { byTitle: R.indexByTitle([{ t: 'other', o: 'shared', y: 2001, k: 'viaOriginal' }, { t: 'shared', y: 2001, k: 'viaTitle' }]) };
eq('a title beats an original title', R.matchLibraryEntry(bothIndex, { title: 'shared', year: '2001' }).k, 'viaTitle');

// =============================================================================
console.log('normalizeRadarrUrl');
eq('adds the missing scheme', R.normalizeRadarrUrl('192.168.1.10:7878'), 'http://192.168.1.10:7878');
eq('keeps https', R.normalizeRadarrUrl('https://radarr.example.com'), 'https://radarr.example.com');
eq('drops a trailing slash', R.normalizeRadarrUrl('http://host:7878/'), 'http://host:7878');
eq('keeps a URL base', R.normalizeRadarrUrl('http://host:7878/radarr'), 'http://host:7878/radarr');
eq('drops a query string', R.normalizeRadarrUrl('http://host:7878/radarr?x=1'), 'http://host:7878/radarr');
eq('trims surrounding space', R.normalizeRadarrUrl('  host:7878  '), 'http://host:7878');
eq('rejects another scheme', R.normalizeRadarrUrl('ftp://host'), '');
eq('rejects nonsense', R.normalizeRadarrUrl('nonsense://'), '');
eq('empty input gives empty output', R.normalizeRadarrUrl(''), '');
eq('null input gives empty output', R.normalizeRadarrUrl(null), '');

console.log('radarrOriginPattern');
eq('a port is not part of the pattern', R.radarrOriginPattern('http://192.168.1.10:7878'), 'http://192.168.1.10/*');
eq('https is preserved', R.radarrOriginPattern('https://radarr.example.com/radarr'), 'https://radarr.example.com/*');

console.log('radarrHasFile');
check('current Radarr reports a file through movieFileId', R.radarrHasFile({ movieFileId: 12 }));
check('and through the nested movieFile', R.radarrHasFile({ movieFile: { id: 4 } }));
check('older Radarr still reports hasFile', R.radarrHasFile({ hasFile: true }));
check('no file means no file', !R.radarrHasFile({ movieFileId: 0, movieFile: null, hasFile: null }));
check('an empty record has no file', !R.radarrHasFile({}));
check('a missing record has no file', !R.radarrHasFile(null));

// =============================================================================
console.log('button wording');
eq('a checking Plex badge', R.badgeLabelFor('checking'), 'Checking…');
eq('an on-server Plex badge', R.badgeLabelFor('server'), 'On Server');
eq('a Discover badge', R.badgeLabelFor('discover'), 'Discover');
eq('anything else is a search', R.badgeLabelFor('whatever'), 'Search');

const view = (state) => R.radarrView(state);
eq('a downloaded film reads Downloaded', view({ status: 'in_library', hasFile: true, monitored: true }).badge, 'Downloaded');
eq('a monitored film with no file reads Wanted', view({ status: 'in_library', hasFile: false, monitored: true }).badge, 'Wanted');
eq('an unmonitored film reads Unmonitored', view({ status: 'in_library', hasFile: false, monitored: false }).badge, 'Unmonitored');
eq('a just-added film reads Added', view({ status: 'in_library', justAdded: true, hasFile: false }).badge, 'Added');
eq('a downloaded film is toned ok', view({ status: 'in_library', hasFile: true }).tone, 'ok');
eq('a wanted film is toned warn', view({ status: 'in_library', monitored: true }).tone, 'warn');
eq('a missing film that can be added offers to add', view({ status: 'missing', canAdd: true }).label, 'Add to Radarr');
eq('a missing film that cannot offers Radarr instead', view({ status: 'missing', canAdd: false }).label, 'Add in Radarr');
eq('no state at all reads as checking', view(null).badge, 'Checking…');
eq('an unknown status is reported as unreachable', view({ status: 'nonsense' }).badge, 'Unreachable');
eq('an error keeps its message', view({ status: 'error', message: 'boom' }).title, 'boom');

eq('a poster + offers to add when it can', R.posterAddView(null, true).label, 'Add to Radarr');
eq('and points at Radarr when it cannot', R.posterAddView(null, false).label, 'Open this in Radarr to add it');
eq('a poster + that is working shows an ellipsis', R.posterAddView({ status: 'adding' }, true).icon, '…');
eq('a finished poster + shows a tick', R.posterAddView({ status: 'added' }, true).icon, '✓');
eq('a failed poster + keeps its message', R.posterAddView({ status: 'error', message: 'nope' }, true).label, 'nope');
eq('a failed poster + without a message still says something', R.posterAddView({ status: 'error' }, true).label, 'Radarr could not add this');

// =============================================================================
console.log('poster grids');
eq('a browse-grid poster gets the small chip', R.posterSizeClass(70), '-sm');
eq('a watchlist poster gets the default chip', R.posterSizeClass(125), '');
eq('a large-grid poster gets the default chip', R.posterSizeClass(150), '');
eq('a list poster gets the large chip', R.posterSizeClass(230), '-lg');
eq('the boundary at 100 is not small', R.posterSizeClass(100), '');
eq('the boundary at 160 is not large', R.posterSizeClass(160), '');

const onPlex = { url: 'x' };
check('showing everything hides nothing', !R.filterHides('all', null) && !R.filterHides('all', onPlex));
check('"on Plex" hides what is not on Plex', R.filterHides('available', null));
check('"on Plex" keeps what is', !R.filterHides('available', onPlex));
check('"not on Plex" hides what is on Plex', R.filterHides('unavailable', onPlex));
check('"not on Plex" keeps what is not', !R.filterHides('unavailable', null));
check('an unanswered poster is never hidden', !R.filterHides('available', undefined) && !R.filterHides('unavailable', undefined));
check('an unknown mode hides nothing', !R.filterHides('nonsense', null));

const answers = { a: onPlex, b: null, c: onPlex };
const tally = R.filterTally(['a', 'b', 'c', 'd'], (s) => answers[s], (s) => s in answers);
eq('a tally counts every poster', tally, { total: 4, available: 2, unavailable: 1, pending: 1 });
eq('an empty grid tallies to zero', R.filterTally([], () => null, () => true),
   { total: 0, available: 0, unavailable: 0, pending: 0 });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
