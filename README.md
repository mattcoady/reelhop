# ReelHop

Hop from the movie sites you already browse to your own media stack. ReelHop is a lightweight Chrome / Brave extension that adds one-click destination buttons to every film page: open the title in **Plex** (your server, Plex Discover, or search) or **add it to Radarr** without leaving the page.

![ReelHop](icons/icon128.png)

**Sources today:** [Letterboxd](https://letterboxd.com), [IMDb](https://www.imdb.com).
**Destinations today:** [Plex](https://www.plex.tv), [Radarr](https://radarr.video). **Next up:** Sonarr and Seerr (Overseerr / Jellyseerr) as destinations, TMDB as a source.

> **Unofficial**: This project is not affiliated with, endorsed by, or sponsored by Plex, Radarr, Letterboxd, IMDb, or any other site it links from or to. Those names are trademarks of their respective owners.

---

## Features

- **Every destination, one button each**
  - On **Letterboxd** film pages: a stacked group of destination buttons in the sidebar, plus a Plex badge in "Where to watch" and a Plex link beside the IMDb / TMDb links.
  - On **IMDb** title pages: a row of destination pills under the title, styled to match IMDb's own buttons (dark and white "Reference view" both handled).
- **Plex** — click **Sign in with Plex** (or paste a token) and links deep-link straight to the film **on your own server** if it's in your library, falling back to its **Plex Discover** page. Signed out, links open Plex search — zero setup.
- **Radarr** — the button tells you where a movie stands (**Downloaded**, **Wanted**, **Unmonitored**) and opens it in Radarr; if it isn't in Radarr yet, one click **adds it** with your chosen quality profile, root folder and minimum availability, optionally kicking off a search right away. TV shows never get a Radarr button (that's Sonarr's job, coming next).
- **Poster badges** — every Letterboxd poster grid (browse pages, lists, your watchlist, "similar films") gets a small Plex mark on the films that are already on your server, so you can see what you own without opening anything. One request per page, not per poster.
- **Availability filter** — a bar above the grid narrows it by Plex (**On Plex** / **Not on Plex**) and by Radarr (**In Radarr** / **Not in Radarr**), with live counts. The two combine, so "Not on Plex" plus "Not in Radarr" is everything on the page worth grabbing. Your choices stick while you page through.
- **Add from the grid** — posters that aren't in Radarr yet carry a quiet **+**. One click adds the film with your chosen profile and root folder, without leaving the page. Or filter down to what's missing and **add the whole page at once**, one confirmation, one at a time, with each poster ticking over as it lands.
- **Movies and TV** — Plex matching covers films and TV shows / mini-series, by IMDb ID when available, with title + year as fallback. No confident match means a search link, never a wrong title.
- **Fast** — Plex results are cached for 7 days; poster badges come from a list of your library titles built once per browser session; Radarr status is re-checked on every visit, and again when a tab comes back into view, so it's never stale after you add or download something.
- **SPA-friendly** — buttons survive dynamic page updates and back/forward navigation.
- **Private by design** — no analytics, no tracking, no third-party servers. Your Plex token and Radarr API key stay on your device and are only sent to Plex's own APIs and to the Radarr address you configured. See [PRIVACY.md](PRIVACY.md).

## Install

Until ReelHop is on the Chrome Web Store, load it unpacked:

1. Clone this repository:
   ```bash
   git clone https://github.com/mattcoady/reelhop.git
   ```
2. Open the extensions page — `chrome://extensions` (Chrome) or `brave://extensions` (Brave).
3. Toggle **Developer mode** (top right).
4. Click **Load unpacked** and select the cloned directory.
5. Click the ReelHop icon in the toolbar to open the settings page (it opens in its own tab).

---

## Setup

ReelHop works out of the box with Plex search links. Everything below is optional.

### Plex (deep links to your server / Discover)

**Sign in with Plex** — click the button on the settings page. A small Plex window opens; sign in there (two-factor included) and it closes itself when done. The settings page then shows your account name and servers. This uses Plex's PIN flow: ReelHop never sees your password, only the resulting token, which stays on this device. Use **Sign out** on the settings page to remove it.

**Paste a token instead** — if you'd rather not sign in:

1. Sign in at [app.plex.tv](https://app.plex.tv) and open any item in your library.
2. `...` (More) menu → **Get Info** → **View XML**.
3. Copy the `X-Plex-Token=...` value from the end of the URL in the address bar.
4. On the settings page, click **Paste a token instead**, paste it, and press **Use this token**. ReelHop checks it with Plex, shows your account name and servers, and keeps it.

**Note on server connections**: ReelHop only contacts your Plex servers over their secure `*.plex.direct` HTTPS addresses (Plex's default for all signed-in servers). Servers reachable only via plain-HTTP LAN addresses won't be found.

### Radarr

1. On the settings page, turn on the **Radarr** switch.
2. Enter your Radarr address as you'd type it in the browser, e.g. `http://192.168.1.10:7878` or `https://radarr.example.com/radarr` (include the URL base if you have one).
3. Paste your API key from Radarr → **Settings → General → Security**.
4. Click **Connect**. Chrome will ask you to allow ReelHop to access that one address — accept. ReelHop then verifies the key, loads your **quality profiles** and **root folders**, and picks the first of each.
5. Change the profile, root folder or **Minimum availability** if you like. Every change saves as you make it.

Without a profile and root folder chosen, the on-page button still works — it opens Radarr's own add page pre-filled with the movie instead of adding directly.

### Settings

The settings page opens in a tab (toolbar icon, or the extension's **Details → Extension options**). There is no Save button: each change is stored the moment you make it.

Each card carries a status dot, mirrored in the side nav. It reports state, not branding: **grey** is off, **green** is working, **amber** needs a step from you, **red** is broken, and a **pulsing** dot means something is in progress. Hover a dot for the reason in words.

| Setting | Default | What it does |
|---|---|---|
| Sign in with Plex | signed out | PIN-based sign-in on plex.tv; enables server / Discover deep-linking |
| Plex token (paste) | empty | Manual alternative to signing in, verified before it is kept |
| Link destination | Smart | Server first → Discover → Search, or pin one destination |
| Plex: Library index | builds on demand | Shows how many of your Plex titles are indexed for poster badges, and rebuilds it |
| Radarr | off | Shows a Radarr button on movie pages |
| Radarr: address / API key | empty | Where Radarr lives and how to authenticate |
| Radarr: Quality profile / Root folder | first available | Used for one-click adds |
| Radarr: Minimum availability | Released | Passed through to Radarr on add |
| Radarr: Search on add | on | Tells Radarr to start looking as soon as the movie is added |
| Letterboxd: Poster badges | on | Marks posters in grids, lists and watchlists that are on your Plex server |
| Letterboxd: Radarr add buttons | on | Puts a + on posters that aren't in Radarr yet |
| Letterboxd: Availability filter | on | Adds the Plex and Radarr filter bar, and bulk add, above poster grids |
| Letterboxd / IMDb placements | all on | Choose which buttons and links to show, per site |
| Open links in a new tab | on | Open destination links in a new tab |
| Data: Clear cache | — | Drops the 7-day film-link cache, both library indexes and the cached server list |

---

## How it works

- A content script reads the film's title, year, IMDb / TMDb IDs and media type from the page and injects the buttons. Each destination is resolved independently and in parallel, so a slow or offline Radarr never delays the Plex link. On Letterboxd it also runs on non-film pages, where its only job is the poster badges.
- All network calls happen in the background service worker. It has permission for Plex's own domains (`plex.tv`, `discover.provider.plex.tv`, `*.plex.direct`) out of the box; access to your Radarr host is an **optional permission** that Chrome grants only when you press **Connect** on the settings page, and only for that host.
- **Sign in with Plex** is Plex's PIN flow: the worker asks `plex.tv` for a PIN, opens Plex's hosted sign-in page in a popup window with that PIN, and polls the PIN until Plex attaches a token. Changing the token (sign-in, paste, sign-out) drops the cached server list and film links so pages re-resolve for the new account.
- **Plex**: with a token, it searches your servers' libraries (`/hubs/search`) and Plex Discover across both movie and TV-show types, matching by IMDb ID first, then normalized title + year (±1). Results are cached locally for 7 days (clearable from the settings page).
- **Poster badges**: searching per poster would mean dozens of requests per grid, so the worker instead lists every movie and show section once (`/library/sections/<id>/all`, trimmed to title, year and rating key) and keeps that index in session storage for 30 minutes. The build publishes its state to session storage as it goes, so the settings page can show it live and offer a **Build now** / **Rebuild** button wherever the build was actually started. The content script sends one message per batch of posters and matches locally on normalized title + year (±1); a title that appears twice with no year to separate it gets no badge rather than a wrong one.
- **Poster + buttons**: Radarr has no batch lookup, so the worker pulls the library once (`GET /api/v3/movie`), trims it to what matching needs, and answers a whole grid from that. The index is held for five minutes and dropped the moment anything is added or a Radarr setting changes. Clicking a + sends the film's title and year to `radarrAdd`, which re-checks Radarr before posting, so a stale + on something already there reports itself as added rather than erroring.
- **Availability filter**: purely local. It reuses the answers the badges already have, hides the grid items the modes exclude, and never asks Plex or Radarr anything extra. Each button's count is what you would see after clicking it, so the other half of the filter is held at its current setting rather than ignored. Bulk add walks the shown films one at a time rather than firing a page of requests at Radarr at once. Posters still waiting on an answer stay visible (the bar says "Checking Plex…") so nothing disappears on a guess, and if a filter empties the page it offers a **Show all** button rather than leaving you on a blank grid. It appears only on pages built around one grid of at least eight films, so preview strips and film pages are left alone.
- **Radarr**: it looks the movie up (`/api/v3/movie/lookup` by IMDb ID, then TMDB ID, then title), confirms whether it's already in your library (`/api/v3/movie?tmdbId=`), and on click POSTs the lookup result back to `/api/v3/movie` with your profile, root folder and availability. The API key is sent only as the `X-Api-Key` header, only to your configured URL.

---

## Roadmap

- [x] Letterboxd support
- [x] IMDb support
- [x] Plex destination
- [x] Radarr destination
- [ ] Sonarr destination (TV shows)
- [ ] Seerr destination (Overseerr / Jellyseerr requests)
- [ ] TMDB as a source
- [ ] Chrome Web Store listing

---

## Development

```
manifest.json     MV3 manifest
shared.js         Pure helpers used by all three sides (matching, wording, URLs)
background.js     Service worker — all Plex and Radarr API calls
content.js        Per-site DOM scraping, destination buttons, Letterboxd poster marks
content.css       Injected button styling
options.html/js/css Settings page (opens in a tab; no popup)
generate_icons.py Regenerates the icon PNGs
test/             Node tests (fake Plex, Plex Media Server and Radarr)
.github/workflows Runs the tests, parses every source file, checks the manifest
```

Run everything with `node test/run.js` (no dependencies), or a single file:

| File | Covers |
|---|---|
| `test/shared.test.js` | `shared.js` on its own: text handling, library matching, URL normalization, every button label |
| `test/background.test.js` | The worker against fake plex.tv, a fake Plex Media Server and a fake Radarr |

**`shared.js` is where testable logic goes.** It is pure — no DOM, no `chrome`, no network — and all three sides load the same copy: the worker via `importScripts`, the content script as the first entry in `content_scripts[].js`, the settings page as a plain `<script>`. Putting a helper there instead of inlining it in `content.js` is what makes it reachable from a test, and it stops the same function existing in three files with three sets of bugs.

Test on any Letterboxd film page (e.g. [The Dark Knight](https://letterboxd.com/film/the-dark-knight/)) or IMDb title page (e.g. [Inception](https://www.imdb.com/title/tt1375666/)). Poster badges show up on any Letterboxd poster grid, such as [popular films of the 2020s](https://letterboxd.com/films/popular/decade/2020s/) or your own watchlist.

### Adding a new source

`content.js` is a site-agnostic engine plus a `SITE_ADAPTERS` registry. To support a new site, add one adapter object and its match pattern — no engine changes:

1. Add an adapter to the `SITE_ADAPTERS` array in [`content.js`](content.js) implementing:
   | Method | Returns | Purpose |
   |---|---|---|
   | `id` | string | Unique key, namespaces the cache |
   | `isFilmPage()` | boolean | Is the current URL a film page on this site? |
   | `getKey()` | string | Stable per-film id (used as cache key) |
   | `extract()` | `{title, year, imdbId, tmdbId, type}` \| `null` | Scrape the film; `type` is `'movie'`, `'show'` or `''` |
   | `inject(view, settings)` | — | Idempotently place buttons; `view = { plex, radarr }` |
   | `isInjected(settings)` | boolean | Are this site's containers still present? |
2. Add the site's URL pattern to `content_scripts[0].matches` in [`manifest.json`](manifest.json).
3. (Optional) Add site-specific styling to [`content.css`](content.css).

Pure logic (title parsing, matching, wording) belongs in [`shared.js`](shared.js) with a test, not inline in the adapter. Injected top-level nodes must carry the `reelhop-injected` class (so the engine can clean them up on navigation). Build the Plex button with `createPlexButton` and place the Radarr button with `syncRadarrButton`, so the engine can repaint both once resolution completes. The IMDb adapter is the minimal reference; the Letterboxd adapter shows multiple placements.

### Adding a new destination

A destination is (a) a section in `background.js` exposing `<name>Resolve` / `<name>Test` (and any actions, like `radarrAdd`) over `chrome.runtime.onMessage`, (b) a state + button painter in `content.js` alongside `radarrState` / `radarrView`, and (c) a card in `options.html` with its controls wired in `options.js` (simple controls just declare a `data-key` and auto-save). If it lives at a user-supplied URL, request its origin with `chrome.permissions.request` from the settings page the way the Radarr card does — don't widen `host_permissions`.

### Packaging for the Chrome Web Store

```bash
zip -r reelhop.zip manifest.json shared.js background.js content.js content.css options.html options.js options.css icons
```

Store listing reminders:
- Set the privacy policy URL to this repo's [PRIVACY.md](PRIVACY.md).
- In the dashboard Privacy tab, disclose that the extension handles **authentication information** (the Plex token and Radarr API key), stored locally only.
- `optional_host_permissions` covers `http://*/*` and `https://*/*` so users can point at any Radarr address; explain in the listing that it's only ever requested for the one host they enter.

---

## Privacy

No analytics, no tracking, no data collection. Everything is stored locally and network requests go only to Plex and to the Radarr address you configure. Full details in [PRIVACY.md](PRIVACY.md).

## License

[MIT](LICENSE)
