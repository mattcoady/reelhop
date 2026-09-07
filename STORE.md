# Chrome Web Store listing

Everything the dashboard asks for, written out so a submission is copy-and-paste
rather than a fresh writing exercise each time. Keep it in step with
[README.md](README.md) and [PRIVACY.md](PRIVACY.md) — the store review reads all
three and will notice if they disagree.

---

## Listing

**Name**

```
ReelHop
```

**Summary** (132 characters max — this one is 108)

```
See what's already on your Plex from Letterboxd and IMDb, and send what isn't straight to Radarr or Sonarr.
```

**Category:** Entertainment
**Language:** English (United Kingdom)

**Description**

```
ReelHop connects the film sites you already browse to the media server you already run.

On a film page it adds a button that goes straight to the title on your own Plex server, falling back to Plex Discover and then to search. On poster grids — Letterboxd browse pages, lists and watchlists, IMDb lists and search results — it marks the titles you already have, so you can see at a glance what is worth an evening.

What isn't there yet can be sent to Radarr (films) or Sonarr (series) in one click, without leaving the page. Narrow a watchlist down to what you don't own and haven't queued, then add the lot in one go.

FEATURES

• Plex deep links — sign in with Plex and buttons open the title on your own server, not a search page
• Poster badges — a small Plex mark on grid posters you already have, on Letterboxd and IMDb
• Availability filter — narrow a grid by what's on Plex and what's in Radarr; the two combine
• Add from the grid — a "+" on posters that aren't in Radarr, or add every film shown at once
• Radarr and Sonarr — see whether a title is Downloaded, Partial, Wanted or Unmonitored, and add it with your chosen quality profile and root folder
• Fast — one request per page, not one per poster

PRIVACY

No analytics. No tracking. No third-party servers. Your Plex token and your Radarr and Sonarr API keys are stored on your device and sent only to Plex's own APIs and to the addresses you configured. Nothing is ever sent to the developer.

ReelHop is unofficial and is not affiliated with Letterboxd, IMDb, Plex, Radarr or Sonarr.
```

---

## Privacy tab

**Single purpose**

```
Linking film and TV pages on Letterboxd and IMDb to the user's own Plex, Radarr and Sonarr servers.
```

**Data types to declare:** *Authentication information* only. Nothing else is
collected — no personally identifiable information, health, financial, location,
web history, user activity or personal communications.

Tick all three certification boxes: data is not sold, not used for anything
outside the single purpose, and not used to determine creditworthiness.

**Privacy policy URL:** this repository's `PRIVACY.md`.

### Permission justifications

Each field below answers one dashboard prompt.

**`storage`**

```
Stores the user's own settings, their Plex token and their Radarr and Sonarr API keys on their device, plus a short-lived cache of film links so pages do not re-query Plex on every visit. Nothing is synced or transmitted.
```

**Host permission — `https://plex.tv/*`, `https://discover.provider.plex.tv/*`, `https://*.plex.direct/*`**

```
These are Plex's own APIs. The extension uses them to run Plex's PIN sign-in flow, to list the servers on the user's account, and to look up whether a title is in the user's library. Requests carry the user's own Plex token as a header, which Plex requires for authentication.
```

**Optional host permissions — `http://*/*` and `https://*/*`**

This is the one a reviewer will ask about, so answer it directly:

```
Radarr and Sonarr are self-hosted. They run at an address only the user knows — commonly a private LAN address such as http://192.168.1.10:7878, but it can be any host, port or URL base. There is no fixed pattern that could be declared ahead of time.

These are optional permissions, never requested at install. The extension asks Chrome for exactly one origin, the one the user typed, at the moment they press "Connect" in its settings. If they decline, the Radarr and Sonarr features simply stay off; everything else keeps working. The extension never requests access to any other site, and the granted origin can be revoked at any time from the extension's details page.
```

**Content scripts — `letterboxd.com` and `imdb.com`**

```
The extension reads the title, year and IMDb/TMDB identifiers from the page in order to find the matching item on the user's own server, and injects its buttons and badges. It runs on all of both sites rather than only on title pages because the poster badges and the availability filter work on browse pages, lists and watchlists. Nothing is read from or sent to these sites beyond the pages the user is already viewing.
```

**Remote code**

```
No. All code is contained in the package; nothing is fetched or evaluated at runtime.
```

---

## Assets

| Asset | Size | Notes |
|---|---|---|
| Store icon | 128×128 PNG | `icons/icon128.png` |
| Screenshot 1 | 1280×800 | Letterboxd film page: sidebar buttons showing "On Server" and a Radarr status |
| Screenshot 2 | 1280×800 | A Letterboxd grid with Plex chips and the filter bar, mid-filter |
| Screenshot 3 | 1280×800 | The same grid narrowed to "Not on Plex" + "Not in Radarr" with the bulk add button armed |
| Screenshot 4 | 1280×800 | The settings page, Plex signed in and the library index built |
| Screenshot 5 | 1280×800 | An IMDb list with Plex chips |

Take screenshots at a browser width around 1280 with the OS in dark mode, which
is what both sites and the settings page are designed against.

---

## Before submitting

- [ ] `node test/run.js` passes
- [ ] Version bumped in `manifest.json`
- [ ] Package rebuilt: see the zip command in [README.md](README.md#packaging-for-the-chrome-web-store)
- [ ] Load the zip unpacked in a clean profile and walk the first run: install → the settings page opens → sign in to Plex → build the index → open a grid
- [ ] `PRIVACY.md` dated and matching the declarations above

## After the first submission

Review usually takes a few days, and the optional host permissions tend to draw
a question. If one arrives, the answer is the paragraph above: the address is
the user's own, it is requested one origin at a time on an explicit button
press, and declining only turns off the Radarr and Sonarr features.
