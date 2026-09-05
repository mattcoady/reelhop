// Popup script for ReelHop

document.addEventListener('DOMContentLoaded', () => {
  const $ = (id) => document.getElementById(id);

  // Plex
  const tokenInput = $('plexToken');
  const autoSyncCheckbox = $('autoSyncToken');
  const modeSelect = $('preferredMode');
  const testBtn = $('testBtn');

  // Radarr
  const radarrEnabled = $('radarrEnabled');
  const radarrBody = $('radarrBody');
  const radarrUrlInput = $('radarrUrl');
  const radarrApiKeyInput = $('radarrApiKey');
  const radarrTestBtn = $('radarrTestBtn');
  const radarrProfileSelect = $('radarrQualityProfile');
  const radarrRootSelect = $('radarrRootFolder');
  const radarrAvailSelect = $('radarrMinAvailability');
  const radarrSearchOnAdd = $('radarrSearchOnAdd');

  // Display
  const newTabCheckbox = $('openInNewTab');
  const showSidebarCheckbox = $('showSidebarButton');
  const showWatchPanelCheckbox = $('showWatchPanel');
  const showDetailsLinkCheckbox = $('showDetailsLink');
  const showImdbButtonCheckbox = $('showImdbButton');

  const saveBtn = $('saveBtn');
  const clearCacheBtn = $('clearCacheBtn');
  const statusMsg = $('statusMessage');

  $('versionLabel').textContent = 'v' + chrome.runtime.getManifest().version;

  let statusTimeout = null;

  // lines: array of strings, or {text, strong} segments per line
  function showStatus(lines, type = 'info', timeout = 6000) {
    if (statusTimeout) {
      clearTimeout(statusTimeout);
      statusTimeout = null;
    }

    statusMsg.textContent = '';
    const lineList = Array.isArray(lines) ? lines : [lines];
    lineList.forEach((line, i) => {
      if (i > 0) statusMsg.appendChild(document.createElement('br'));
      const segments = Array.isArray(line) ? line : [{ text: line }];
      for (const seg of segments) {
        if (seg.strong) {
          const strong = document.createElement('strong');
          strong.textContent = seg.text;
          statusMsg.appendChild(strong);
        } else {
          statusMsg.appendChild(document.createTextNode(seg.text));
        }
      }
    });

    statusMsg.className = `status-msg ${type}`;
    statusMsg.style.display = 'block';

    if (timeout > 0) {
      statusTimeout = setTimeout(() => {
        statusMsg.style.display = 'none';
      }, timeout);
    }
  }

  // ---------------------------------------------------------------------------
  // Radarr helpers
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

  function syncRadarrBody() {
    radarrBody.hidden = !radarrEnabled.checked;
  }
  radarrEnabled.addEventListener('change', syncRadarrBody);

  // ---------------------------------------------------------------------------
  // Load existing settings
  // ---------------------------------------------------------------------------

  chrome.storage.local.get([
    'plexToken',
    'autoSyncToken',
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
  ], (items) => {
    if (items.plexToken) tokenInput.value = items.plexToken;
    autoSyncCheckbox.checked = items.autoSyncToken === true;
    if (items.preferredMode) modeSelect.value = items.preferredMode;
    if (typeof items.openInNewTab !== 'undefined') newTabCheckbox.checked = items.openInNewTab;
    if (typeof items.showSidebarButton !== 'undefined') showSidebarCheckbox.checked = items.showSidebarButton;
    if (typeof items.showWatchPanel !== 'undefined') showWatchPanelCheckbox.checked = items.showWatchPanel;
    if (typeof items.showDetailsLink !== 'undefined') showDetailsLinkCheckbox.checked = items.showDetailsLink;
    if (typeof items.showImdbButton !== 'undefined') showImdbButtonCheckbox.checked = items.showImdbButton;

    radarrEnabled.checked = items.radarrEnabled === true;
    radarrUrlInput.value = items.radarrUrl || '';
    radarrApiKeyInput.value = items.radarrApiKey || '';
    radarrAvailSelect.value = items.radarrMinAvailability || 'released';
    radarrSearchOnAdd.checked = items.radarrSearchOnAdd !== false;
    renderRadarrOptions(items.radarrProfiles || [], items.radarrRootFolders || [],
      items.radarrQualityProfileId, items.radarrRootFolder);
    syncRadarrBody();
  });

  // ---------------------------------------------------------------------------
  // Save
  // ---------------------------------------------------------------------------

  saveBtn.addEventListener('click', async () => {
    const radarrUrl = normalizeRadarrUrl(radarrUrlInput.value);
    const warnings = [];

    if (radarrEnabled.checked) {
      if (!radarrUrl) {
        warnings.push('Radarr URL is missing or invalid, so Radarr buttons will stay hidden.');
      } else if (!radarrApiKeyInput.value.trim()) {
        warnings.push('Radarr API key is missing; on-page buttons will ask you to finish setup.');
      } else {
        try {
          const granted = await requestRadarrAccess(radarrUrl);
          if (!granted) warnings.push(`Access to ${new URL(radarrUrl).host} was declined, so Radarr can't be reached.`);
        } catch (e) {
          warnings.push(`Could not request access to ${radarrUrl}: ${e.message}`);
        }
      }
    }
    if (radarrUrl) radarrUrlInput.value = radarrUrl;

    chrome.storage.local.set({
      plexToken: tokenInput.value.trim(),
      autoSyncToken: autoSyncCheckbox.checked,
      preferredMode: modeSelect.value,
      openInNewTab: newTabCheckbox.checked,
      showSidebarButton: showSidebarCheckbox.checked,
      showWatchPanel: showWatchPanelCheckbox.checked,
      showDetailsLink: showDetailsLinkCheckbox.checked,
      showImdbButton: showImdbButtonCheckbox.checked,
      radarrEnabled: radarrEnabled.checked,
      radarrUrl,
      radarrApiKey: radarrApiKeyInput.value.trim(),
      radarrQualityProfileId: radarrProfileSelect.value ? parseInt(radarrProfileSelect.value, 10) : 0,
      radarrRootFolder: radarrRootSelect.value || '',
      radarrMinAvailability: radarrAvailSelect.value,
      radarrSearchOnAdd: radarrSearchOnAdd.checked
    }, () => {
      if (warnings.length > 0) {
        showStatus(['✓ Settings saved.', ...warnings.map(w => `⚠️ ${w}`)], 'info', 9000);
      } else {
        showStatus('✓ Settings saved successfully!', 'success', 3000);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Test Plex token & servers (the actual requests run in the background worker)
  // ---------------------------------------------------------------------------

  testBtn.addEventListener('click', async () => {
    const token = tokenInput.value.trim();
    if (!token) {
      showStatus('⚠️ Please enter a Plex Token first to test.', 'error', 4000);
      return;
    }

    testBtn.disabled = true;
    testBtn.textContent = 'Testing...';
    showStatus('⏳ Checking Plex account & servers...', 'info', 0);

    try {
      const result = await chrome.runtime.sendMessage({ action: 'plexTest', token });

      if (!result || result.error) {
        showStatus(`❌ Network error: ${result?.error || 'no response'}`, 'error', 6000);
      } else if (!result.ok) {
        showStatus([
          [{ text: '❌ ' }, { text: 'Invalid Plex Token', strong: true }, { text: ' (401 Unauthorized). Please check the token.' }]
        ], 'error', 8000);
      } else {
        const lines = [
          [{ text: '✓ Connected as ' }, { text: result.username || 'Plex User', strong: true }, { text: '!' }]
        ];
        if (result.serverNames && result.serverNames.length > 0) {
          lines.push([{ text: '📡 Detected Server: ' }, { text: result.serverNames.join(', '), strong: true }]);
        }
        lines.push('✨ Ready to link your movies with Plex!');
        showStatus(lines, 'success', 8000);
      }
    } catch (e) {
      console.error('Test error:', e);
      showStatus(`❌ Network error: ${e.message}`, 'error', 6000);
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = 'Test Token & Server';
    }
  });

  // ---------------------------------------------------------------------------
  // Connect to Radarr: grant access, verify the key, load profiles + folders
  // ---------------------------------------------------------------------------

  radarrTestBtn.addEventListener('click', async () => {
    const url = normalizeRadarrUrl(radarrUrlInput.value);
    const apiKey = radarrApiKeyInput.value.trim();
    if (!url) {
      showStatus('⚠️ Enter your Radarr URL first, e.g. http://192.168.1.10:7878', 'error', 5000);
      return;
    }
    if (!apiKey) {
      showStatus('⚠️ Enter your Radarr API key first (Radarr → Settings → General → Security).', 'error', 5000);
      return;
    }
    radarrUrlInput.value = url;

    radarrTestBtn.disabled = true;
    radarrTestBtn.textContent = 'Connecting...';
    showStatus('⏳ Connecting to Radarr...', 'info', 0);

    try {
      const granted = await requestRadarrAccess(url);
      if (!granted) {
        showStatus(`❌ Access to ${new URL(url).host} was declined. ReelHop can't reach Radarr without it.`, 'error', 8000);
        return;
      }

      const result = await chrome.runtime.sendMessage({ action: 'radarrTest', config: { url, apiKey } });
      if (!result || result.error) {
        showStatus(`❌ ${result?.error || 'No response from the extension.'}`, 'error', 6000);
        return;
      }
      if (!result.ok) {
        const messages = {
          unauthorized: 'Radarr rejected the API key (401). Copy it again from Settings → General → Security.',
          unreachable: `Could not reach ${url}. Is Radarr running, and is that address reachable from this computer?`,
          wrong_app: `That looks like ${result.appName}, not Radarr.`,
          permission: 'Chrome has not granted access to that address yet. Press Connect again and accept the prompt.',
          http: `Radarr answered HTTP ${result.status}. Check the URL, including any URL base.`,
          bad_url: 'That URL does not look valid.',
          no_key: 'Enter your API key first.'
        };
        showStatus(`❌ ${messages[result.reason] || 'Could not connect to Radarr.'}`, 'error', 9000);
        return;
      }

      renderRadarrOptions(result.profiles, result.rootFolders, radarrProfileSelect.value, radarrRootSelect.value);
      // Remember the option lists so the dropdowns are populated next time,
      // even before Save.
      chrome.storage.local.set({ radarrProfiles: result.profiles, radarrRootFolders: result.rootFolders });

      const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
      const lines = [
        [{ text: '✓ Connected to ' }, { text: result.instanceName, strong: true },
         { text: result.version ? ` (Radarr v${result.version})` : '' }],
        `${plural(result.profiles.length, 'quality profile')}, ${plural(result.rootFolders.length, 'root folder')} loaded.`
      ];
      if (result.profiles.length === 0 || result.rootFolders.length === 0) {
        lines.push('⚠️ Radarr needs at least one quality profile and one root folder before ReelHop can add movies.');
      } else {
        lines.push('Pick a profile and root folder above, then Save.');
      }
      showStatus(lines, 'success', 10000);
    } catch (e) {
      console.error('Radarr test error:', e);
      showStatus(`❌ ${e.message}`, 'error', 6000);
    } finally {
      radarrTestBtn.disabled = false;
      radarrTestBtn.textContent = 'Connect & Load Options';
    }
  });

  // Clear cached film -> Plex URL mappings (stored in chrome.storage.local)
  clearCacheBtn.addEventListener('click', () => {
    chrome.storage.local.get(null, (items) => {
      const cacheKeys = Object.keys(items).filter(k => k.startsWith('cacheTarget_'));
      if (cacheKeys.length === 0) {
        showStatus('ℹ️ No cached film mappings to clear.', 'info', 3000);
        return;
      }
      chrome.storage.local.remove(cacheKeys, () => {
        showStatus(`ℹ️ Cleared ${cacheKeys.length} cached film mappings.`, 'info', 3000);
      });
    });
  });
});
