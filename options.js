// Settings page for ReelHop. Every control saves as soon as it changes; the
// network calls (Plex, Radarr) run in the background service worker.

document.addEventListener('DOMContentLoaded', () => {
  // Firefox's promise-based namespace is `browser`; its `chrome` is the
  // callback-style alias, and this file is written against promises. Bind to
  // whichever the browser provides, so one source runs on both.
  const chrome = globalThis.browser || globalThis.chrome;

  // The worker's own URL handling, so what the user sees saved is exactly what
  // gets called (shared.js is loaded before this file).
  const { normalizeRadarrUrl, radarrOriginPattern } = ReelHop;

  const $ = (id) => document.getElementById(id);

  // Plex
  const tokenInput = $('plexToken');
  const plexTokenSaveBtn = $('plexTokenSaveBtn');
  const plexSignedOut = $('plexSignedOut');
  const plexPending = $('plexPending');
  const plexSignedIn = $('plexSignedIn');
  const plexSignInBtn = $('plexSignInBtn');
  const plexCancelBtn = $('plexCancelBtn');
  const plexSignOutBtn = $('plexSignOutBtn');
  const plexTokenToggle = $('plexTokenToggle');
  const plexTokenManual = $('plexTokenManual');
  const plexUsernameEl = $('plexUsername');
  const plexServersEl = $('plexServers');
  const plexNote = $('plexNote');
  const plexAccessRow = $('plexAccessRow');
  const plexAccessBtn = $('plexAccessBtn');
  const modeSelect = $('preferredMode');

  // Radarr and Sonarr each own the rest of their card (see wireArrService);
  // these are the two settings that differ between them.
  const radarrAvailSelect = $('radarrMinAvailability');
  const sonarrMonitorSelect = $('sonarrMonitor');

  // Display + general
  const newTabCheckbox = $('openInNewTab');
  const showSidebarCheckbox = $('showSidebarButton');
  const showWatchPanelCheckbox = $('showWatchPanel');
  const showDetailsLinkCheckbox = $('showDetailsLink');
  const showPosterBadgesCheckbox = $('showPosterBadges');
  const showPosterFilterCheckbox = $('showPosterFilter');
  const showPosterAddCheckbox = $('showPosterAdd');
  const showImdbButtonCheckbox = $('showImdbButton');

  // Plex library index
  const plexIndexStatusEl = $('plexIndexStatus');
  const plexIndexDesc = $('plexIndexDesc');
  const plexIndexBtn = $('plexIndexBtn');
  const plexIndexNote = $('plexIndexNote');

  // Data
  const clearCacheBtn = $('clearCacheBtn');
  const cacheCountEl = $('cacheCount');
  const dataNote = $('dataNote');

  const toast = $('toast');

  $('versionLabel').textContent = 'v' + chrome.runtime.getManifest().version;

  // ---------------------------------------------------------------------------
  // Feedback: a transient toast for saves, an inline note per card for detail
  // ---------------------------------------------------------------------------

  let toastTimer = null;
  function showToast(text, type = 'saved', timeout = 1800) {
    toast.textContent = text;
    toast.className = `toast show ${type}`;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.className = 'toast'; }, timeout);
  }

  // lines: a string, or an array of lines; each line a string or an array of
  // {text, strong} segments.
  function renderLines(el, lines) {
    el.textContent = '';
    const lineList = Array.isArray(lines) ? lines : [lines];
    lineList.forEach((line, i) => {
      if (i > 0) el.appendChild(document.createElement('br'));
      const segments = Array.isArray(line) ? line : [{ text: line }];
      for (const seg of segments) {
        if (seg.strong) {
          const strong = document.createElement('strong');
          strong.textContent = seg.text;
          el.appendChild(strong);
        } else {
          el.appendChild(document.createTextNode(seg.text));
        }
      }
    });
  }

  const noteTimers = new Map();
  function showNote(el, lines, type = 'info', timeout = 6000) {
    if (noteTimers.has(el)) {
      clearTimeout(noteTimers.get(el));
      noteTimers.delete(el);
    }
    renderLines(el, lines);
    el.className = `note ${type}`;
    if (timeout > 0) {
      noteTimers.set(el, setTimeout(() => hideNote(el), timeout));
    }
  }

  function hideNote(el) {
    if (noteTimers.has(el)) {
      clearTimeout(noteTimers.get(el));
      noteTimers.delete(el);
    }
    el.className = 'note';
    el.textContent = '';
  }

  // ---------------------------------------------------------------------------
  // Auto-save
  // ---------------------------------------------------------------------------

  async function save(values, { silent = false } = {}) {
    try {
      await chrome.storage.local.set(values);
      if (!silent) showToast('Saved');
      return true;
    } catch (e) {
      showToast(`Could not save: ${e.message}`, 'error', 5000);
      return false;
    }
  }

  function controlValue(el) {
    if (el.type === 'checkbox') return el.checked;
    if (el.dataset.type === 'int') return el.value ? parseInt(el.value, 10) : 0;
    return el.value;
  }

  // Simple controls declare the storage key they own via data-key.
  document.querySelectorAll('[data-key]').forEach((el) => {
    el.addEventListener('change', () => {
      save({ [el.dataset.key]: controlValue(el) });
    });
  });

  // A source is "on" when at least one of its placements is, so its dot has to
  // follow every one of them.
  for (const id of ['showSidebarButton', 'showWatchPanel', 'showDetailsLink',
                    'showPosterBadges', 'showPosterAdd', 'showImdbButton']) {
    $(id).addEventListener('change', refreshSourceDots);
  }

  // ---------------------------------------------------------------------------
  // Plex account (Sign in with Plex)
  // ---------------------------------------------------------------------------

  let plexPendingPoll = null;

  let plexAccountState = 'out';
  let plexIndexState = 'none';

  function refreshPlexDot(indexStatus) {
    if (indexStatus !== undefined) plexIndexState = indexStatus;
    else indexStatus = plexIndexState;
    if (plexAccountState === 'pending') return setDot('Plex', 'busy', 'Plex: signing in');
    if (plexAccountState !== 'in') return setDot('Plex', '', 'Plex: signed out, links open Plex search');
    if (indexStatus === 'building') return setDot('Plex', 'busy', 'Plex: indexing your libraries');
    if (indexStatus === 'unreachable' || indexStatus === 'error') return setDot('Plex', 'warn', 'Plex: signed in, but no server answered');
    setDot('Plex', 'on', 'Plex: signed in');
  }

  function showPlexState(state) {
    plexAccountState = state;
    plexSignedOut.hidden = state !== 'out';
    plexPending.hidden = state !== 'pending';
    plexSignedIn.hidden = state !== 'in';
    refreshPlexDot();
  }

  function describeServers(names) {
    return names && names.length > 0 ? `Servers: ${names.join(', ')}` : 'No servers found on this account.';
  }

  function setTokenFieldVisible(visible) {
    plexTokenManual.hidden = !visible;
    plexTokenToggle.textContent = visible ? 'Hide the token field' : 'Paste a token instead';
    if (visible) tokenInput.focus();
  }

  // Host access to Plex
  //
  // Chrome grants the manifest's host_permissions at install, so there the
  // check below is always true and the row stays hidden. Firefox treats
  // Manifest V3 host permissions as opt-in: until the user grants them every
  // Plex call fails, so ask for them on a button press, which is the only
  // context permissions.request() accepts. The list comes from the manifest
  // rather than a copy here, so the two cannot drift.
  const PLEX_ORIGINS = chrome.runtime.getManifest().host_permissions || [];

  // Fails open: if the check itself errors, leave the controls enabled and let
  // the real request report the real problem.
  function hasPlexAccess() {
    if (PLEX_ORIGINS.length === 0) return Promise.resolve(true);
    return chrome.permissions.contains({ origins: PLEX_ORIGINS }).catch(() => true);
  }

  async function refreshPlexAccess() {
    const granted = await hasPlexAccess();
    plexAccessRow.hidden = granted;
    plexSignInBtn.disabled = !granted;
    plexTokenSaveBtn.disabled = !granted;
    return granted;
  }

  plexAccessBtn.addEventListener('click', async () => {
    try {
      const granted = await chrome.permissions.request({ origins: PLEX_ORIGINS });
      if (!granted) {
        showNote(plexNote, "Without access to Plex's own domains ReelHop cannot sign in or check your library.", 'error', 6000);
        return;
      }
      await refreshPlexAccess();
      refreshPlexAccount();
      refreshPlexIndex();
    } catch (e) {
      showNote(plexNote, `Could not ask for access to Plex: ${e.message}`, 'error', 7000);
    }
  });

  // The grant can also be changed from the browser's own extensions page
  // while this one is open.
  for (const evt of ['onAdded', 'onRemoved']) {
    if (chrome.permissions[evt]) chrome.permissions[evt].addListener(() => refreshPlexAccess());
  }

  async function refreshPlexAccount() {
    const [items, status] = await Promise.all([
      chrome.storage.local.get(['plexToken', 'plexUsername', 'plexServerNames']),
      chrome.runtime.sendMessage({ action: 'plexSignInStatus' }).catch(() => null)
    ]);

    // One-time outcome of a sign-in that finished (reported once by the worker).
    if (status && status.status === 'done') {
      showNote(plexNote, [[{ text: '✓ Signed in to Plex' }, { text: status.username ? ` as ${status.username}` : '', strong: true }]], 'success', 5000);
    } else if (status && status.status === 'expired') {
      showNote(plexNote, 'The Plex sign-in timed out. Try again.', 'error', 6000);
    } else if (status && status.status === 'cancelled') {
      showNote(plexNote, 'Plex sign-in was cancelled.', 'info', 4000);
    }

    const pending = !!status && status.status === 'pending';
    if (pending) {
      showPlexState('pending');
      if (!plexPendingPoll) plexPendingPoll = setInterval(refreshPlexAccount, 1500);
      return;
    }
    if (plexPendingPoll) {
      clearInterval(plexPendingPoll);
      plexPendingPoll = null;
    }

    if (!items.plexToken) {
      showPlexState('out');
      return;
    }

    showPlexState('in');
    plexUsernameEl.textContent = items.plexUsername || 'your Plex account';
    plexServersEl.textContent = describeServers(items.plexServerNames);

    if (!items.plexUsername) {
      // A token saved by an older version: look up who it belongs to, once.
      const info = await chrome.runtime.sendMessage({ action: 'plexTest', token: items.plexToken }).catch(() => null);
      if (info && info.ok) {
        chrome.storage.local.set({ plexUsername: info.username || '', plexServerNames: info.serverNames || [] });
        plexUsernameEl.textContent = info.username || 'your Plex account';
        plexServersEl.textContent = describeServers(info.serverNames);
      } else if (info && info.ok === false) {
        plexServersEl.textContent = 'Plex rejected this token. Sign out and sign in again.';
      }
    }
  }

  plexSignInBtn.addEventListener('click', async () => {
    plexSignInBtn.disabled = true;
    hideNote(plexNote);
    try {
      const res = await chrome.runtime.sendMessage({ action: 'plexSignInStart' });
      if (!res || res.error) {
        showNote(plexNote, `Could not start Plex sign-in: ${res?.error || 'no response'}`, 'error', 7000);
        return;
      }
      refreshPlexAccount();
    } catch (e) {
      showNote(plexNote, `Could not start Plex sign-in: ${e.message}`, 'error', 7000);
    } finally {
      plexSignInBtn.disabled = false;
    }
  });

  plexCancelBtn.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ action: 'plexSignInCancel' }).catch(() => {});
    refreshPlexAccount();
  });

  plexSignOutBtn.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ action: 'plexSignOut' }).catch(() => {});
    tokenInput.value = '';
    showNote(plexNote, 'Signed out of Plex. Plex buttons now open Plex search.', 'info', 4000);
    refreshPlexAccount();
    refreshCacheCount();
  });

  plexTokenToggle.addEventListener('click', () => {
    setTokenFieldVisible(plexTokenManual.hidden);
  });

  // Paste-a-token path: verify with Plex, then store. A token Plex rejects
  // outright (401) is not saved; one that merely can't be verified right now is.
  async function useToken() {
    const token = tokenInput.value.trim();
    if (!token) {
      showNote(plexNote, 'Paste a Plex token first.', 'error', 4000);
      tokenInput.focus();
      return;
    }

    plexTokenSaveBtn.disabled = true;
    plexTokenSaveBtn.textContent = 'Checking…';
    showNote(plexNote, 'Checking the token with Plex…', 'info', 0);

    try {
      const result = await chrome.runtime.sendMessage({ action: 'plexTest', token }).catch((e) => ({ error: e.message }));

      if (result && result.ok === false) {
        showNote(plexNote, [
          [{ text: 'Plex rejected that token', strong: true }, { text: ' (401 Unauthorized). Check it and try again.' }]
        ], 'error', 8000);
        return;
      }

      const verified = !!(result && result.ok);
      const saved = await save({
        plexToken: token,
        plexUsername: verified ? (result.username || '') : '',
        plexServerNames: verified ? (result.serverNames || []) : []
      }, { silent: true });
      if (!saved) return;

      tokenInput.value = '';
      setTokenFieldVisible(false);

      if (verified) {
        const lines = [[{ text: '✓ Connected as ' }, { text: result.username || 'Plex user', strong: true }]];
        if (result.serverNames && result.serverNames.length > 0) {
          lines.push([{ text: 'Servers: ' }, { text: result.serverNames.join(', '), strong: true }]);
        }
        showNote(plexNote, lines, 'success', 8000);
      } else {
        showNote(plexNote, `Token saved, but Plex could not be reached to verify it (${result?.error || 'no response'}). It will be checked when a film page needs it.`, 'info', 9000);
      }
      refreshPlexAccount();
    } finally {
      plexTokenSaveBtn.disabled = false;
      plexTokenSaveBtn.textContent = 'Use this token';
    }
  }

  plexTokenSaveBtn.addEventListener('click', useToken);
  tokenInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      useToken();
    }
  });

  // ---------------------------------------------------------------------------
  // Radarr and Sonarr
  //
  // The two are the same card with different nouns: an address, an API key, a
  // Connect button that asks Chrome for access to that one host and then loads
  // the quality profiles and root folders, plus one service-specific setting.
  // wireArrService builds both from a spec rather than keeping two copies of
  // two hundred lines that would drift apart.
  // ---------------------------------------------------------------------------

  function hasHostAccess(url) {
    return chrome.permissions.contains({ origins: [radarrOriginPattern(url)] }).catch(() => false);
  }

  // Ask Chrome for access to the host. Resolves true immediately when it's
  // already granted, otherwise shows Chrome's permission prompt.
  function requestHostAccess(url) {
    return chrome.permissions.request({ origins: [radarrOriginPattern(url)] });
  }

  function formatBytes(n) {
    if (typeof n !== 'number' || !isFinite(n) || n <= 0) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = n;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
  }

  function fillSelect(select, items, valueOf, labelOf, selected, placeholder) {
    select.textContent = '';
    if (!items || items.length === 0) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = placeholder;
      select.appendChild(o);
      return;
    }
    for (const item of items) {
      const o = document.createElement('option');
      o.value = String(valueOf(item));
      o.textContent = labelOf(item);
      select.appendChild(o);
    }
    const want = selected === undefined || selected === null ? '' : String(selected);
    if (want && Array.from(select.options).some(o => o.value === want)) select.value = want;
  }

  // spec: { key: 'radarr', name: 'Radarr', item: 'movies', port: '7878', ... }
  // The element ids, storage keys and message actions all derive from `key`,
  // which is what keeps the two cards honest about being the same thing.
  function wireArrService(spec) {
    const { key, name, dot, item, port, keyPath } = spec;
    const el = {
      enabled: $(`${key}Enabled`),
      off: $(`${key}Off`),
      body: $(`${key}Body`),
      url: $(`${key}Url`),
      apiKey: $(`${key}ApiKey`),
      testBtn: $(`${key}TestBtn`),
      conn: $(`${key}Conn`),
      note: $(`${key}Note`),
      profile: $(`${key}QualityProfile`),
      root: $(`${key}RootFolder`)
    };
    const storeKeys = {
      enabled: `${key}Enabled`,
      url: `${key}Url`,
      apiKey: `${key}ApiKey`,
      searchOnAdd: `${key}SearchOnAdd`,
      profileId: `${key}QualityProfileId`,
      rootFolder: `${key}RootFolder`,
      profiles: `${key}Profiles`,
      rootFolders: `${key}RootFolders`
    };

    function renderOptions(profiles, rootFolders, selectedProfile, selectedRoot) {
      fillSelect(el.profile, profiles, p => p.id, p => p.name, selectedProfile, 'Connect to load…');
      fillSelect(el.root, rootFolders, r => r.path, (r) => {
        const free = formatBytes(r.freeSpace);
        return free ? `${r.path}  (${free} free)` : r.path;
      }, selectedRoot, 'Connect to load…');
    }

    // The dropdowns always show *some* choice once options are loaded; make
    // sure storage agrees with what is shown, so one-click add works right away.
    async function syncChoices(stored) {
      const shownProfile = el.profile.value ? parseInt(el.profile.value, 10) : 0;
      const shownRoot = el.root.value || '';
      const update = {};
      if ((stored[storeKeys.profileId] || 0) !== shownProfile) update[storeKeys.profileId] = shownProfile;
      if ((stored[storeKeys.rootFolder] || '') !== shownRoot) update[storeKeys.rootFolder] = shownRoot;
      if (Object.keys(update).length > 0) await save(update, { silent: true });
    }

    function setConn(text, tone) {
      el.conn.textContent = text;
      el.conn.className = `conn-status ${tone}`;
      if (!el.enabled.checked) setDot(dot, '', `${name}: turned off`);
      else if (tone === 'ok') setDot(dot, 'on', `${name}: ${text.toLowerCase()}`);
      else if (tone === 'err') setDot(dot, 'err', `${name}: ${text.toLowerCase()}`);
      else if (tone === 'warn') setDot(dot, 'warn', `${name}: ${text.toLowerCase()}`);
      else setDot(dot, 'warn', `${name}: on, but not connected yet`);
    }

    function failureMessage(result, url) {
      if (!result || result.error) return result?.error || 'No response from the extension.';
      const host = (() => { try { return new URL(url).host; } catch (e) { return url; } })();
      const messages = {
        unauthorized: `${name} rejected the API key (401). Copy it again from Settings → General → Security.`,
        unreachable: `Could not reach ${host}. Is ${name} running, and is that address reachable from this computer?`,
        wrong_app: `That looks like ${result.appName}, not ${name}.`,
        permission: 'Chrome has not granted access to that address yet. Press Connect and accept the prompt.',
        http: `${name} answered HTTP ${result.status}. Check the address, including any URL base.`,
        bad_url: 'That address does not look valid.',
        no_key: 'Enter your API key first.'
      };
      return messages[result.reason] || `Could not connect to ${name}.`;
    }

    function connectedLabel(result) {
      return `Connected to ${result.instanceName || name}${result.version ? ` · v${result.version}` : ''}`;
    }

    // Reflect the current connection state in the pill next to Connect. With
    // verify=true (page load, toggle on) it also pings the service once.
    let connCheckSeq = 0;
    async function refreshConn({ verify = true } = {}) {
      const seq = ++connCheckSeq;
      const url = normalizeRadarrUrl(el.url.value);
      const apiKey = el.apiKey.value.trim();

      if (!url || !apiKey) {
        setConn('Not connected', 'muted');
        return;
      }
      const granted = await hasHostAccess(url);
      if (seq !== connCheckSeq) return;
      if (!granted) {
        setConn(`Needs access to ${new URL(url).host}`, 'warn');
        return;
      }
      if (!verify) return;

      setConn('Checking…', 'muted');
      const result = await chrome.runtime.sendMessage({ action: `${key}Test`, config: { url, apiKey } })
        .catch((e) => ({ error: e.message }));
      if (seq !== connCheckSeq) return;
      if (result && result.ok) {
        setConn(connectedLabel(result), 'ok');
      } else {
        setConn('Connection failed', 'err');
        showNote(el.note, failureMessage(result, url), 'error', 0);
      }
    }

    function syncBody() {
      el.body.hidden = !el.enabled.checked;
      el.off.hidden = el.enabled.checked;
      if (!el.enabled.checked) setDot(dot, '', `${name}: turned off`);
    }

    el.enabled.addEventListener('change', () => {
      syncBody();
      if (el.enabled.checked) refreshConn();
    });

    el.url.addEventListener('change', async () => {
      const raw = el.url.value.trim();
      const url = normalizeRadarrUrl(raw);
      if (raw && !url) {
        showNote(el.note, `That address does not look valid. Use something like http://192.168.1.10:${port}`, 'error', 6000);
        return;
      }
      hideNote(el.note);
      el.url.value = url;
      await save({ [storeKeys.url]: url });
      refreshConn({ verify: false });
    });

    el.apiKey.addEventListener('change', async () => {
      await save({ [storeKeys.apiKey]: el.apiKey.value.trim() });
      refreshConn({ verify: false });
    });

    el.testBtn.addEventListener('click', async () => {
      const url = normalizeRadarrUrl(el.url.value);
      const apiKey = el.apiKey.value.trim();
      if (!url) {
        showNote(el.note, `Enter your ${name} address first, e.g. http://192.168.1.10:${port}`, 'error', 5000);
        el.url.focus();
        return;
      }
      if (!apiKey) {
        showNote(el.note, `Enter your API key first (${keyPath}).`, 'error', 5000);
        el.apiKey.focus();
        return;
      }
      el.url.value = url;
      await save({ [storeKeys.url]: url, [storeKeys.apiKey]: apiKey }, { silent: true });

      el.testBtn.disabled = true;
      el.testBtn.textContent = 'Connecting…';
      connCheckSeq++; // cancel any background check in flight
      setConn('Connecting…', 'muted');
      showNote(el.note, `Connecting to ${name}…`, 'info', 0);

      try {
        const granted = await requestHostAccess(url);
        if (!granted) {
          setConn(`Needs access to ${new URL(url).host}`, 'warn');
          showNote(el.note, `Access to ${new URL(url).host} was declined. ReelHop can't reach ${name} without it.`, 'error', 8000);
          return;
        }

        const result = await chrome.runtime.sendMessage({ action: `${key}Test`, config: { url, apiKey } })
          .catch((e) => ({ error: e.message }));
        if (!result || result.error || !result.ok) {
          setConn('Connection failed', 'err');
          showNote(el.note, failureMessage(result, url), 'error', 9000);
          return;
        }

        const stored = await chrome.storage.local.get([storeKeys.profileId, storeKeys.rootFolder]);
        renderOptions(result.profiles, result.rootFolders, stored[storeKeys.profileId], stored[storeKeys.rootFolder]);
        await save({ [storeKeys.profiles]: result.profiles, [storeKeys.rootFolders]: result.rootFolders }, { silent: true });
        await syncChoices(stored);

        setConn(connectedLabel(result), 'ok');

        const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
        const lines = [
          [{ text: '✓ Connected to ' }, { text: result.instanceName || name, strong: true },
           { text: result.version ? ` (${name} v${result.version})` : '' }],
          `${plural(result.profiles.length, 'quality profile')}, ${plural(result.rootFolders.length, 'root folder')} loaded.`
        ];
        if (result.profiles.length === 0 || result.rootFolders.length === 0) {
          lines.push(`${name} needs at least one quality profile and one root folder before ReelHop can add ${item}.`);
        } else {
          const profileName = el.profile.options[el.profile.selectedIndex]?.textContent || '';
          lines.push([{ text: 'Adding with ' }, { text: profileName, strong: true }, { text: ' into ' },
            { text: el.root.value, strong: true }, { text: '. Change either below if needed.' }]);
        }
        showNote(el.note, lines, 'success', 12000);
      } catch (e) {
        console.error(`${name} connect error:`, e);
        setConn('Connection failed', 'err');
        showNote(el.note, e.message, 'error', 6000);
      } finally {
        el.testBtn.disabled = false;
        el.testBtn.textContent = 'Connect';
      }
    });

    // What the load block needs to bring the card up to date.
    return { key, name, dot, el, storeKeys, renderOptions, syncChoices, refreshConn, syncBody, searchOnAdd: $(`${key}SearchOnAdd`) };
  }

  const radarr = wireArrService({
    key: 'radarr', name: 'Radarr', dot: 'Radarr', item: 'movies', port: '7878',
    keyPath: 'Radarr → Settings → General → Security'
  });
  const sonarr = wireArrService({
    key: 'sonarr', name: 'Sonarr', dot: 'Sonarr', item: 'series', port: '8989',
    keyPath: 'Sonarr → Settings → General → Security'
  });

  // ---------------------------------------------------------------------------
  // Status dots
  //
  // One per card, mirrored in the side nav. They report state, not brand:
  // grey off, green working, amber needs a step, red broken, pulsing busy.
  // ---------------------------------------------------------------------------

  function setDot(name, tone, label) {
    for (const el of [$(`dot${name}`), $(`navDot${name}`)]) {
      if (!el) continue;
      el.className = `dest-dot ${tone}`.trim();
      el.title = label;
      el.setAttribute('aria-label', label);
    }
  }

  function refreshSourceDots() {
    const lb = showSidebarCheckbox.checked || showWatchPanelCheckbox.checked ||
               showDetailsLinkCheckbox.checked || showPosterBadgesCheckbox.checked ||
               showPosterAddCheckbox.checked;
    setDot('Letterboxd', lb ? 'on' : '', lb ? 'Letterboxd: showing' : 'Letterboxd: everything turned off');
    const imdb = showImdbButtonCheckbox.checked;
    setDot('Imdb', imdb ? 'on' : '', imdb ? 'IMDb: showing' : 'IMDb: turned off');
  }

  // ---------------------------------------------------------------------------
  // Plex library index
  // ---------------------------------------------------------------------------

  function relativeMinutes(timestamp) {
    const mins = Math.max(0, Math.round((Date.now() - timestamp) / 60000));
    return mins < 1 ? 'just now' : `${mins} min ago`;
  }

  function setIndexStatus(text, tone) {
    plexIndexStatusEl.textContent = text;
    plexIndexStatusEl.className = `conn-status ${tone}`.trim();
  }

  function renderIndexStatus(info) {
    const status = (info && info.status) || 'none';
    if (status === 'building') {
      setIndexStatus('Indexing…', 'busy');
      plexIndexDesc.textContent = 'Reading the titles in your Plex libraries. This can take a moment on a big server.';
      plexIndexBtn.disabled = true;
      plexIndexBtn.textContent = 'Indexing…';
      return status;
    }
    plexIndexBtn.disabled = status === 'no_token';
    plexIndexBtn.textContent = status === 'ready' ? 'Rebuild' : 'Build now';

    if (status === 'no_token') {
      setIndexStatus('Needs sign-in', 'muted');
      plexIndexDesc.textContent = 'Sign in to Plex and the index builds from your own libraries.';
    } else if (status === 'ready') {
      const n = info.entries.toLocaleString();
      setIndexStatus(`${n} title${info.entries === 1 ? '' : 's'}`, info.stale ? 'warn' : 'ok');
      plexIndexDesc.textContent = `From ${info.servers} server${info.servers === 1 ? '' : 's'}, built ${relativeMinutes(info.timestamp)}.` +
        (info.stale ? ' It will refresh on the next grid you open.' : '');
    } else if (status === 'unreachable') {
      setIndexStatus('No server reached', 'err');
      plexIndexDesc.textContent = 'None of your Plex servers answered. Poster badges stay off until one does.';
    } else if (status === 'error') {
      setIndexStatus('Failed', 'err');
      plexIndexDesc.textContent = info.message || 'The index could not be built.';
    } else {
      setIndexStatus('Not built', 'muted');
      plexIndexDesc.textContent = 'Builds itself the first time you open a Letterboxd grid, or press Build now.';
    }
    return status;
  }

  async function refreshPlexIndex() {
    const info = await chrome.runtime.sendMessage({ action: 'plexIndexStatus' }).catch(() => null);
    const status = renderIndexStatus(info);
    refreshPlexDot(status);
    refreshCacheCount();
    return status;
  }

  plexIndexBtn.addEventListener('click', async () => {
    hideNote(plexIndexNote);
    renderIndexStatus({ status: 'building' });
    refreshPlexDot('building');
    const info = await chrome.runtime.sendMessage({ action: 'plexIndexRebuild' }).catch((e) => ({ status: 'error', message: e.message }));
    const status = renderIndexStatus(info);
    refreshPlexDot(status);
    refreshCacheCount();
    if (status === 'ready') {
      showNote(plexIndexNote, `Indexed ${info.entries.toLocaleString()} title${info.entries === 1 ? '' : 's'}. Letterboxd grids will use it right away.`, 'success', 5000);
    } else if (status === 'unreachable' || status === 'error') {
      showNote(plexIndexNote, info.message || 'Could not reach any of your Plex servers.', 'error', 0);
    }
  });

  // ---------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------

  async function cacheKeys() {
    const items = await chrome.storage.local.get(null);
    return Object.keys(items).filter(k => k.startsWith('cacheTarget_'));
  }

  // The Plex card reports the index itself; here we only need to know whether
  // there is one to clear.
  async function hasLibraryIndex() {
    try {
      const { libraryIndex } = await chrome.storage.session.get('libraryIndex');
      return !!(libraryIndex && Array.isArray(libraryIndex.entries));
    } catch (e) {
      return false;
    }
  }

  async function refreshCacheCount() {
    const keys = await cacheKeys();
    const hasIndex = await hasLibraryIndex();
    cacheCountEl.textContent = keys.length === 0
      ? 'No cached film links.'
      : `${keys.length} cached film link${keys.length === 1 ? '' : 's'}.`;
    clearCacheBtn.disabled = keys.length === 0 && !hasIndex;
  }

  clearCacheBtn.addEventListener('click', async () => {
    const keys = await cacheKeys();
    const hadIndex = await hasLibraryIndex();
    try { await chrome.storage.session.remove(['serverCache', 'libraryIndex', 'libraryIndexState', 'radarrIndex']); } catch (e) {}
    if (keys.length > 0) await chrome.storage.local.remove(keys);
    const parts = [];
    if (keys.length > 0) parts.push(`${keys.length} cached film link${keys.length === 1 ? '' : 's'}`);
    if (hadIndex) parts.push('the Plex and Radarr library indexes');
    parts.push('the cached server list');
    const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
    showNote(dataNote, `Cleared ${list}. Pages rebuild them on the next visit.`, 'info', 4000);
    refreshPlexIndex();
  });

  // ---------------------------------------------------------------------------
  // Section navigation
  // ---------------------------------------------------------------------------

  const sections = Array.from(document.querySelectorAll('section.card[id]'));
  const navLinks = Array.from(document.querySelectorAll('.nav-link'));

  function setActiveNav(id) {
    navLinks.forEach(a => a.classList.toggle('active', a.getAttribute('href') === `#${id}`));
  }

  // While a deliberate jump (nav click, hash, focus request) is scrolling, the
  // chosen section stays highlighted even if the page is too short to bring it
  // to the top; scroll-spy takes over again once the user scrolls.
  let navLockUntil = 0;
  function lockNav(id) {
    setActiveNav(id);
    navLockUntil = Date.now() + 1200;
  }

  function updateNav() {
    if (Date.now() < navLockUntil) return;
    const probe = window.scrollY + 110;
    let current = sections[0];
    for (const s of sections) {
      if (s.getBoundingClientRect().top + window.scrollY <= probe) current = s;
    }
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) {
      current = sections[sections.length - 1];
    }
    setActiveNav(current.id);
  }

  navLinks.forEach((a) => {
    a.addEventListener('click', () => lockNav(a.getAttribute('href').slice(1)));
  });

  let navRaf = 0;
  window.addEventListener('scroll', () => {
    if (navRaf) return;
    navRaf = requestAnimationFrame(() => { navRaf = 0; updateNav(); });
  }, { passive: true });
  window.addEventListener('resize', updateNav);

  // Jump to a section and flash its outline. Used for #hash links and for the
  // on-page "Needs access" / "Setup" buttons, which ask the worker to open
  // this page on a section (passed through session storage).
  function focusSection(id) {
    const el = document.getElementById(id);
    if (!el || !el.classList.contains('card')) return;
    lockNav(id);
    el.scrollIntoView({ block: 'start' });
    el.classList.remove('flash');
    void el.offsetWidth; // restart the animation if it is already running
    el.classList.add('flash');
    if (location.hash !== `#${id}`) history.replaceState(null, '', `#${id}`);
  }

  async function consumeFocusRequest() {
    try {
      const { optionsFocus } = await chrome.storage.session.get('optionsFocus');
      if (!optionsFocus) return;
      await chrome.storage.session.remove('optionsFocus');
      focusSection(optionsFocus.section);
    } catch (e) {
      // Session storage unavailable: nothing to do.
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes.optionsFocus && changes.optionsFocus.newValue) {
      consumeFocusRequest();
    }
    // A grid page (or another settings tab) can start a build at any time.
    if (area === 'session' && changes.libraryIndexState) {
      refreshPlexIndex();
    }
    if (area === 'local' && (changes.plexToken || changes.plexUsername)) {
      refreshPlexAccount();
      refreshPlexIndex();
    }
  });

  // ---------------------------------------------------------------------------
  // Load
  // ---------------------------------------------------------------------------

  chrome.storage.local.get([
    'openInNewTab',
    'preferredMode',
    'showSidebarButton',
    'showWatchPanel',
    'showDetailsLink',
    'showImdbButton',
    'showPosterBadges',
    'showPosterAdd',
    'showPosterFilter',
    'radarrEnabled',
    'radarrUrl',
    'radarrApiKey',
    'radarrQualityProfileId',
    'radarrRootFolder',
    'radarrMinAvailability',
    'radarrSearchOnAdd',
    'radarrProfiles',
    'radarrRootFolders',
    'sonarrEnabled',
    'sonarrUrl',
    'sonarrApiKey',
    'sonarrQualityProfileId',
    'sonarrRootFolder',
    'sonarrMonitor',
    'sonarrSearchOnAdd',
    'sonarrProfiles',
    'sonarrRootFolders'
  ], async (items) => {
    modeSelect.value = items.preferredMode || 'server_first';
    newTabCheckbox.checked = items.openInNewTab !== false;
    showSidebarCheckbox.checked = items.showSidebarButton !== false;
    showWatchPanelCheckbox.checked = items.showWatchPanel !== false;
    showDetailsLinkCheckbox.checked = items.showDetailsLink !== false;
    showPosterBadgesCheckbox.checked = items.showPosterBadges !== false;
    showPosterAddCheckbox.checked = items.showPosterAdd !== false;
    showPosterFilterCheckbox.checked = items.showPosterFilter !== false;
    showImdbButtonCheckbox.checked = items.showImdbButton !== false;

    // Both *arr cards restore the same way; only the extra setting differs.
    for (const service of [radarr, sonarr]) {
      const k = service.storeKeys;
      service.el.enabled.checked = items[k.enabled] === true;
      service.el.url.value = items[k.url] || '';
      service.el.apiKey.value = items[k.apiKey] || '';
      service.searchOnAdd.checked = items[k.searchOnAdd] !== false;
      service.renderOptions(items[k.profiles] || [], items[k.rootFolders] || [],
        items[k.profileId], items[k.rootFolder]);
      if ((items[k.profiles] || []).length > 0 || (items[k.rootFolders] || []).length > 0) {
        service.syncChoices(items);
      }
      service.syncBody();
    }
    radarrAvailSelect.value = items.radarrMinAvailability || 'released';
    sonarrMonitorSelect.value = items.sonarrMonitor || 'all';

    refreshPlexAccess();
    refreshSourceDots();
    refreshPlexAccount();
    refreshPlexIndex();
    for (const service of [radarr, sonarr]) {
      if (service.el.enabled.checked) service.refreshConn();
      else setDot(service.dot, '', `${service.name}: turned off`);
    }
    refreshCacheCount();
    updateNav();
    if (location.hash.length > 1) focusSection(location.hash.slice(1));
    consumeFocusRequest();
  });
});
