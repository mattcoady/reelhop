// Optional Plex token auto-sync.
// Only runs when the user has explicitly enabled "Auto-sync token" in the
// extension popup (off by default). When enabled, it copies the Plex access
// token from the user's own app.plex.tv session into chrome.storage.local so
// they don't have to find and paste it manually. The token never leaves the
// browser and is only ever sent to Plex's own APIs.
(function () {
  'use strict';

  function syncPlexToken() {
    chrome.storage.local.get(['autoSyncToken', 'plexToken'], (items) => {
      if (items.autoSyncToken !== true) return;

      try {
        const token = localStorage.getItem('myPlexAccessToken');
        if (token && items.plexToken !== token) {
          chrome.storage.local.set({ plexToken: token }, () => {
            console.log('[ReelHop] Plex token auto-synced from app.plex.tv');
          });
        }
      } catch (e) {
        console.warn('[ReelHop] Could not read Plex token:', e);
      }
    });
  }

  syncPlexToken();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      syncPlexToken();
    }
  });
})();
