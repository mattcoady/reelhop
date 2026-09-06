// Settings page for ReelHop. Every control saves as soon as it changes; the
// network calls (Plex, Radarr) run in the background service worker.

document.addEventListener('DOMContentLoaded', () => {
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
  const modeSelect = $('preferredMode');

  // Radarr
  const radarrEnabled = $('radarrEnabled');
  const radarrOff = $('radarrOff');
  const radarrBody = $('radarrBody');
  const radarrUrlInput = $('radarrUrl');
  const radarrApiKeyInput = $('radarrApiKey');
  const radarrTestBtn = $('radarrTestBtn');
  const radarrConn = $('radarrConn');
  const radarrNote = $('radarrNote');
  const radarrProfileSelect = $('radarrQualityProfile');
  const radarrRootSelect = $('radarrRootFolder');
  const radarrAvailSelect = $('radarrMinAvailability');
  const radarrSearchOnAdd = $('radarrSearchOnAdd');

  // Display + general
  const newTabCheckbox = $('openInNewTab');
  const showSidebarCheckbox = $('showSidebarButton');
  const showWatchPanelCheckbox = $('showWatchPanel');
  const showDetailsLinkCheckbox = $('showDetailsLink');
  const showImdbButtonCheckbox = $('showImdbButton');

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

  // ---------------------------------------------------------------------------
  // Plex account (Sign in with Plex)
  // ---------------------------------------------------------------------------

  let plexPendingPoll = null;

  function showPlexState(state) {
    plexSignedOut.hidden = state !== 'out';
    plexPending.hidden = state !== 'pending';
    plexSignedIn.hidden = state !== 'in';
  }

  function describeServers(names) {
    return names && names.length > 0 ? `Servers: ${names.join(', ')}` : 'No servers found on this account.';
  }

  function setTokenFieldVisible(visible) {
    plexTokenManual.hidden = !visible;
    plexTokenToggle.textContent = visible ? 'Hide the token field' : 'Paste a token instead';
    if (visible) tokenInput.focus();
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
  // Radarr
  // ---------------------------------------------------------------------------

  // Same normalization the background worker applies, so what the user sees
  // saved is exactly what gets called.
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

  function radarrOriginPattern(url) {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}/*`;
  }

  function hasRadarrAccess(url) {
    return chrome.permissions.contains({ origins: [radarrOriginPattern(url)] }).catch(() => false);
  }

  // Ask Chrome for access to the Radarr host. Resolves true immediately when
  // it's already granted, otherwise shows Chrome's permission prompt.
  function requestRadarrAccess(url) {
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

  function renderRadarrOptions(profiles, rootFolders, selectedProfile, selectedRoot) {
    fillSelect(radarrProfileSelect, profiles, p => p.id, p => p.name, selectedProfile, 'Connect to load…');
    fillSelect(radarrRootSelect, rootFolders, r => r.path, (r) => {
      const free = formatBytes(r.freeSpace);
      return free ? `${r.path}  (${free} free)` : r.path;
    }, selectedRoot, 'Connect to load…');
  }

  // The dropdowns always show *some* choice once options are loaded; make sure
  // storage agrees with what is shown, so one-click add works right away.
  async function syncRadarrChoices(stored) {
    const shownProfile = radarrProfileSelect.value ? parseInt(radarrProfileSelect.value, 10) : 0;
    const shownRoot = radarrRootSelect.value || '';
    const update = {};
    if ((stored.radarrQualityProfileId || 0) !== shownProfile) update.radarrQualityProfileId = shownProfile;
    if ((stored.radarrRootFolder || '') !== shownRoot) update.radarrRootFolder = shownRoot;
    if (Object.keys(update).length > 0) await save(update, { silent: true });
  }

  function setConn(text, tone) {
    radarrConn.textContent = text;
    radarrConn.className = `conn-status ${tone}`;
  }

  function radarrFailureMessage(result, url) {
    if (!result || result.error) return result?.error || 'No response from the extension.';
    const host = (() => { try { return new URL(url).host; } catch (e) { return url; } })();
    const messages = {
      unauthorized: 'Radarr rejected the API key (401). Copy it again from Settings → General → Security.',
      unreachable: `Could not reach ${host}. Is Radarr running, and is that address reachable from this computer?`,
      wrong_app: `That looks like ${result.appName}, not Radarr.`,
      permission: 'Chrome has not granted access to that address yet. Press Connect and accept the prompt.',
      http: `Radarr answered HTTP ${result.status}. Check the address, including any URL base.`,
      bad_url: 'That address does not look valid.',
      no_key: 'Enter your API key first.'
    };
    return messages[result.reason] || 'Could not connect to Radarr.';
  }

  function connectedLabel(result) {
    return `Connected to ${result.instanceName || 'Radarr'}${result.version ? ` · v${result.version}` : ''}`;
  }

  // Reflect the current connection state in the pill next to Connect. With
  // verify=true (page load, toggle on) it also pings Radarr once.
  let connCheckSeq = 0;
  async function refreshRadarrConn({ verify = true } = {}) {
    const seq = ++connCheckSeq;
    const url = normalizeRadarrUrl(radarrUrlInput.value);
    const apiKey = radarrApiKeyInput.value.trim();

    if (!url || !apiKey) {
      setConn('Not connected', 'muted');
      return;
    }
    const granted = await hasRadarrAccess(url);
    if (seq !== connCheckSeq) return;
    if (!granted) {
      setConn(`Needs access to ${new URL(url).host}`, 'warn');
      return;
    }
    if (!verify) return;

    setConn('Checking…', 'muted');
    const result = await chrome.runtime.sendMessage({ action: 'radarrTest', config: { url, apiKey } }).catch((e) => ({ error: e.message }));
    if (seq !== connCheckSeq) return;
    if (result && result.ok) {
      setConn(connectedLabel(result), 'ok');
    } else {
      setConn('Connection failed', 'err');
      showNote(radarrNote, radarrFailureMessage(result, url), 'error', 0);
    }
  }

  function syncRadarrBody() {
    radarrBody.hidden = !radarrEnabled.checked;
    radarrOff.hidden = radarrEnabled.checked;
  }

  radarrEnabled.addEventListener('change', () => {
    syncRadarrBody();
    if (radarrEnabled.checked) refreshRadarrConn();
  });

  radarrUrlInput.addEventListener('change', async () => {
    const raw = radarrUrlInput.value.trim();
    const url = normalizeRadarrUrl(raw);
    if (raw && !url) {
      showNote(radarrNote, 'That address does not look valid. Use something like http://192.168.1.10:7878', 'error', 6000);
      return;
    }
    hideNote(radarrNote);
    radarrUrlInput.value = url;
    await save({ radarrUrl: url });
    refreshRadarrConn({ verify: false });
  });

  radarrApiKeyInput.addEventListener('change', async () => {
    await save({ radarrApiKey: radarrApiKeyInput.value.trim() });
    refreshRadarrConn({ verify: false });
  });

  // Connect: grant access to the host, verify the key, load profiles + folders.
  radarrTestBtn.addEventListener('click', async () => {
    const url = normalizeRadarrUrl(radarrUrlInput.value);
    const apiKey = radarrApiKeyInput.value.trim();
    if (!url) {
      showNote(radarrNote, 'Enter your Radarr address first, e.g. http://192.168.1.10:7878', 'error', 5000);
      radarrUrlInput.focus();
      return;
    }
    if (!apiKey) {
      showNote(radarrNote, 'Enter your API key first (Radarr → Settings → General → Security).', 'error', 5000);
      radarrApiKeyInput.focus();
      return;
    }
    radarrUrlInput.value = url;
    await save({ radarrUrl: url, radarrApiKey: apiKey }, { silent: true });

    radarrTestBtn.disabled = true;
    radarrTestBtn.textContent = 'Connecting…';
    connCheckSeq++; // cancel any background check in flight
    setConn('Connecting…', 'muted');
    showNote(radarrNote, 'Connecting to Radarr…', 'info', 0);

    try {
      const granted = await requestRadarrAccess(url);
      if (!granted) {
        setConn(`Needs access to ${new URL(url).host}`, 'warn');
        showNote(radarrNote, `Access to ${new URL(url).host} was declined. ReelHop can't reach Radarr without it.`, 'error', 8000);
        return;
      }

      const result = await chrome.runtime.sendMessage({ action: 'radarrTest', config: { url, apiKey } }).catch((e) => ({ error: e.message }));
      if (!result || result.error || !result.ok) {
        setConn('Connection failed', 'err');
        showNote(radarrNote, radarrFailureMessage(result, url), 'error', 9000);
        return;
      }

      const stored = await chrome.storage.local.get(['radarrQualityProfileId', 'radarrRootFolder']);
      renderRadarrOptions(result.profiles, result.rootFolders, stored.radarrQualityProfileId, stored.radarrRootFolder);
      await save({ radarrProfiles: result.profiles, radarrRootFolders: result.rootFolders }, { silent: true });
      await syncRadarrChoices(stored);

      setConn(connectedLabel(result), 'ok');

      const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
      const lines = [
        [{ text: '✓ Connected to ' }, { text: result.instanceName || 'Radarr', strong: true },
         { text: result.version ? ` (Radarr v${result.version})` : '' }],
        `${plural(result.profiles.length, 'quality profile')}, ${plural(result.rootFolders.length, 'root folder')} loaded.`
      ];
      if (result.profiles.length === 0 || result.rootFolders.length === 0) {
        lines.push('Radarr needs at least one quality profile and one root folder before ReelHop can add movies.');
      } else {
        const profileName = radarrProfileSelect.options[radarrProfileSelect.selectedIndex]?.textContent || '';
        lines.push([{ text: 'Adding with ' }, { text: profileName, strong: true }, { text: ' into ' },
          { text: radarrRootSelect.value, strong: true }, { text: '. Change either below if needed.' }]);
      }
      showNote(radarrNote, lines, 'success', 12000);
    } catch (e) {
      console.error('Radarr connect error:', e);
      setConn('Connection failed', 'err');
      showNote(radarrNote, e.message, 'error', 6000);
    } finally {
      radarrTestBtn.disabled = false;
      radarrTestBtn.textContent = 'Connect';
    }
  });

  // ---------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------

  async function cacheKeys() {
    const items = await chrome.storage.local.get(null);
    return Object.keys(items).filter(k => k.startsWith('cacheTarget_'));
  }

  async function refreshCacheCount() {
    const keys = await cacheKeys();
    cacheCountEl.textContent = keys.length === 0
      ? 'No cached film links.'
      : `${keys.length} cached film link${keys.length === 1 ? '' : 's'}.`;
    clearCacheBtn.disabled = keys.length === 0;
  }

  clearCacheBtn.addEventListener('click', async () => {
    const keys = await cacheKeys();
    try { await chrome.storage.session.remove('serverCache'); } catch (e) {}
    if (keys.length > 0) await chrome.storage.local.remove(keys);
    showNote(dataNote, keys.length === 0
      ? 'Nothing to clear. The cached server list was refreshed anyway.'
      : `Cleared ${keys.length} cached film link${keys.length === 1 ? '' : 's'} and the cached server list.`, 'info', 4000);
    refreshCacheCount();
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
    if (area === 'local' && (changes.plexToken || changes.plexUsername)) {
      refreshPlexAccount();
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
    'radarrEnabled',
    'radarrUrl',
    'radarrApiKey',
    'radarrQualityProfileId',
    'radarrRootFolder',
    'radarrMinAvailability',
    'radarrSearchOnAdd',
    'radarrProfiles',
    'radarrRootFolders'
  ], async (items) => {
    modeSelect.value = items.preferredMode || 'server_first';
    newTabCheckbox.checked = items.openInNewTab !== false;
    showSidebarCheckbox.checked = items.showSidebarButton !== false;
    showWatchPanelCheckbox.checked = items.showWatchPanel !== false;
    showDetailsLinkCheckbox.checked = items.showDetailsLink !== false;
    showImdbButtonCheckbox.checked = items.showImdbButton !== false;

    radarrEnabled.checked = items.radarrEnabled === true;
    radarrUrlInput.value = items.radarrUrl || '';
    radarrApiKeyInput.value = items.radarrApiKey || '';
    radarrAvailSelect.value = items.radarrMinAvailability || 'released';
    radarrSearchOnAdd.checked = items.radarrSearchOnAdd !== false;
    renderRadarrOptions(items.radarrProfiles || [], items.radarrRootFolders || [],
      items.radarrQualityProfileId, items.radarrRootFolder);
    if ((items.radarrProfiles || []).length > 0 || (items.radarrRootFolders || []).length > 0) {
      syncRadarrChoices(items);
    }
    syncRadarrBody();

    refreshPlexAccount();
    if (radarrEnabled.checked) refreshRadarrConn();
    refreshCacheCount();
    updateNav();
    if (location.hash.length > 1) focusSection(location.hash.slice(1));
    consumeFocusRequest();
  });
});
