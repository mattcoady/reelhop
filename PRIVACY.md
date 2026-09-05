# Privacy Policy — ReelHop

_Last updated: September 5, 2026_

**ReelHop** is a browser extension that adds destination buttons (Plex, Radarr) to movie pages on Letterboxd and IMDb. It is designed to collect as little data as possible, and nothing it handles ever leaves your device except requests made directly to the services you have connected.

## What the extension stores

All data is stored locally in your browser via `chrome.storage.local` and is never transmitted to the developer or any third party:

- **Plex authentication token** (optional): only if you paste one into the settings popup, or if you explicitly enable the off-by-default "Auto-sync token from app.plex.tv" option, in which case the token is read from your own signed-in app.plex.tv session. The token is used solely to query Plex's APIs on your behalf.
- **Radarr URL and API key** (optional): only if you enable the Radarr destination and enter them in the popup. They are used solely to query, and add movies to, your own Radarr instance.
- **Radarr option lists**: the names of your quality profiles and root folder paths, fetched when you press "Connect" so the popup can offer them as choices.
- **Settings**: your display and behavior preferences.
- **Film link cache**: mappings from films to Plex URLs, kept for 7 days to avoid repeated lookups. You can clear this at any time from the popup. Radarr status is not cached beyond the current page.
- **A random client identifier**: generated locally, sent only to Plex as the standard `X-Plex-Client-Identifier` header.

## What the extension sends, and to whom

Network requests are made only to the services you have configured, and only when you have provided credentials for them:

- `plex.tv` — to verify your Plex token and list your own Plex servers.
- `discover.provider.plex.tv` — to look up films on Plex Discover.
- Your own Plex server(s) via their secure `*.plex.direct` addresses — to check whether a film is in your library.
- **Your own Radarr instance**, at the exact address you entered — to look up a movie, check whether it is already in your library, load your quality profiles and root folders, and (only when you click the button) add the movie. Access to this address is an optional browser permission that Chrome asks you to grant when you save it; ReelHop never requests access to any other site.

Requests to Plex include your Plex token as a header, and requests to Radarr include your API key as the `X-Api-Key` header, because those services require them for authentication. No data is sent to Letterboxd or IMDb beyond loading the pages you visit normally, and no data is ever sent to the developer.

## What the extension does NOT do

- No analytics, telemetry, or tracking of any kind.
- No collection of browsing history.
- No selling, sharing, or transferring of user data to anyone.
- No use of data for purposes unrelated to the extension's single purpose: linking movie pages to your own media services.

## Data removal

Uninstalling the extension removes all stored data. You can also clear the film cache from the popup, or remove your credentials by clearing the token / API key fields and saving. Revoking the Radarr host permission is possible at any time from your browser's extension details page.

## Contact

Questions about this policy can be raised by opening an issue on the project's repository.
