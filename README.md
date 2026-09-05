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
- **Plex** — with an optional Plex token, links deep-link straight to the film **on your own server** if it's in your library, falling back to its **Plex Discover** page. Without a token, links open Plex search — zero setup.
- **Radarr** — the button tells you where a movie stands (**Downloaded**, **Wanted**, **Unmonitored**) and opens it in Radarr; if it isn't in Radarr yet, one click **adds it** with your chosen quality profile, root folder and minimum availability, optionally kicking off a search right away. TV shows never get a Radarr button (that's Sonarr's job, coming next).
- **Movies and TV** — Plex matching covers films and TV shows / mini-series, by IMDb ID when available, with title + year as fallback. No confident match means a search link, never a wrong title.
- **Fast** — Plex results are cached for 7 days; Radarr status is re-checked on every visit so it's never stale after you add something.
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
5. Click the ReelHop icon in the toolbar to open settings.

---

## Setup

ReelHop works out of the box with Plex search links. Everything below is optional.

### Plex (deep links to your server / Discover)

**Easiest** — in the popup, enable **"Auto-sync token from app.plex.tv"** (off by default), then visit [app.plex.tv](https://app.plex.tv) while signed in. The token is picked up from your own session automatically.

**Manually**:

1. Sign in at [app.plex.tv](https://app.plex.tv) and open any item in your library.
2. `...` (More) menu → **Get Info** → **View XML**.
3. Copy the `X-Plex-Token=...` value from the end of the URL in the address bar.
4. Paste it into the popup and hit **Save Settings**.

Use **Test Token & Server** to verify — it shows your account name and detected servers.

**Note on server connections**: ReelHop only contacts your Plex servers over their secure `*.plex.direct` HTTPS addresses (Plex's default for all signed-in servers). Servers reachable only via plain-HTTP LAN addresses won't be found.

### Radarr

1. In the popup, tick **Enable** on the Radarr card.
2. Enter your Radarr URL as you'd type it in the browser, e.g. `http://192.168.1.10:7878` or `https://radarr.example.com/radarr` (include the URL base if you have one).
3. Paste your API key from Radarr → **Settings → General → Security**.
4. Click **Connect & Load Options**. Chrome will ask you to allow ReelHop to access that one address — accept. ReelHop then verifies the key and loads your **quality profiles** and **root folders**.
5. Pick the profile and root folder new movies should use, set **Minimum Availability**, and **Save Settings**.

Without a profile and root folder chosen, the on-page button still works — it opens Radarr's own add page pre-filled with the movie instead of adding directly.

### Settings

| Setting | Default | What it does |
|---|---|---|
| Plex Token | empty | Enables server / Discover deep-linking |
| Auto-sync token | off | Reads the token from your own app.plex.tv session |
| Link Destination Priority | Smart | Server first → Discover → Search, or pin one destination |
| Radarr: Enable | off | Shows a Radarr button on movie pages |
| Radarr: URL / API key | empty | Where Radarr lives and how to authenticate |
| Radarr: Quality Profile / Root Folder | first available | Used for one-click adds |
| Radarr: Minimum Availability | Released | Passed through to Radarr on add |
| Radarr: Search on add | on | Tells Radarr to start looking as soon as the movie is added |
| Display Locations | all on | Choose which placements to show, per site |
| Open in new tab | on | Open destination links in a new tab |

---

## How it works

- A content script reads the film's title, year, IMDb / TMDb IDs and media type from the page and injects the buttons. Each destination is resolved independently and in parallel, so a slow or offline Radarr never delays the Plex link.
- All network calls happen in the background service worker. It has permission for Plex's own domains (`plex.tv`, `discover.provider.plex.tv`, `*.plex.direct`) out of the box; access to your Radarr host is an **optional permission** that Chrome grants only when you save a Radarr URL in the popup, and only for that host.
- **Plex**: with a token, it searches your servers' libraries (`/hubs/search`) and Plex Discover across both movie and TV-show types, matching by IMDb ID first, then normalized title + year (±1). Results are cached locally for 7 days (clearable from the popup).
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
background.js     Service worker — all Plex and Radarr API calls
content.js        Per-site DOM scraping + destination buttons
content.css       Injected button styling
plex-sync.js      Opt-in Plex token auto-sync on app.plex.tv
popup.html/js/css Settings popup
generate_icons.py Regenerates the icon PNGs
```

Test on any Letterboxd film page (e.g. [The Dark Knight](https://letterboxd.com/film/the-dark-knight/)) or IMDb title page (e.g. [Inception](https://www.imdb.com/title/tt1375666/)).

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

Injected top-level nodes must carry the `reelhop-injected` class (so the engine can clean them up on navigation). Build the Plex button with `createPlexButton` and place the Radarr button with `syncRadarrButton`, so the engine can repaint both once resolution completes. The IMDb adapter is the minimal reference; the Letterboxd adapter shows multiple placements.

### Adding a new destination

A destination is (a) a section in `background.js` exposing `<name>Resolve` / `<name>Test` (and any actions, like `radarrAdd`) over `chrome.runtime.onMessage`, (b) a state + button painter in `content.js` alongside `radarrState` / `radarrView`, and (c) a card in the popup. If it lives at a user-supplied URL, request its origin with `chrome.permissions.request` from the popup the way the Radarr card does — don't widen `host_permissions`.

### Packaging for the Chrome Web Store

```bash
zip -r reelhop.zip manifest.json background.js content.js content.css plex-sync.js popup.html popup.js popup.css icons
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
