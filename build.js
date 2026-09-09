// Builds the packages for both browsers:  node build.js
//
//   dist/chrome/    + dist/reelhop-chrome-<version>.zip     Chrome Web Store
//   dist/firefox/   + dist/reelhop-firefox-<version>.zip    addons.mozilla.org
//
// manifest.json in the repo root is the Chrome manifest and the single source
// of truth for name, version and description; the Firefox one is derived from
// it here so the two cannot drift the way the manifest and STORE.md once did.
//
// The zip is written by hand rather than shelling out. `zip` is not on Windows,
// and PowerShell's Compress-Archive writes backslash separators, which makes
// `icons/icon16.png` unfindable inside the package.
//
// Loading unpacked for development: Chrome can load the repo root directly.
// Firefox needs dist/firefox, because its manifest is the generated one.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');

// Everything the packages ship, apart from the manifest, which differs per
// target. verifyPackage() below cross-checks this against what the manifests
// and options.html actually reference.
const PACKAGE_FILES = [
  'shared.js',
  'background.js',
  'content.js',
  'content.css',
  'options.html',
  'options.js',
  'options.css',
  'icons/icon16.png',
  'icons/icon48.png',
  'icons/icon128.png'
];

// An add-on id is required for AMO. strict_min_version is 115 because that is
// where storage.session arrived, which the library index and the sign-in
// session both depend on.
const GECKO = {
  id: 'reelhop@mattcoady.github.io',
  strict_min_version: '115.0'
};

// ---------------------------------------------------------------------------
// Manifests
// ---------------------------------------------------------------------------

function firefoxManifest(chromeManifest) {
  const src = JSON.parse(JSON.stringify(chromeManifest));
  const out = {};
  // Rebuilt key by key so browser_specific_settings lands somewhere a person
  // would look for it, rather than tacked on the end.
  for (const [key, value] of Object.entries(src)) {
    out[key] = value;
    if (key === 'description') out.browser_specific_settings = { gecko: { ...GECKO } };
  }
  // Firefox has no extension service workers. The same background.js runs as a
  // non-persistent background page, with shared.js ahead of it because
  // importScripts() does not exist outside a worker.
  out.background = { scripts: ['shared.js', 'background.js'] };
  return out;
}

// Every file a manifest points at, so a rename that misses one fails the build
// instead of shipping an extension that cannot start.
function manifestFiles(m) {
  const background = m.background.service_worker
    ? [m.background.service_worker]
    : (m.background.scripts || []);
  return [
    ...background,
    m.options_ui && m.options_ui.page,
    ...(m.content_scripts || []).flatMap(c => [...(c.js || []), ...(c.css || [])]),
    ...Object.values(m.icons || {}),
    ...Object.values((m.action && m.action.default_icon) || {})
  ].filter(Boolean);
}

// options.html loads its own script and stylesheet with plain tags, so those
// two never appear in the manifest. This is the gap that would otherwise ship
// a settings page with no CSS.
function htmlFiles(html) {
  const refs = [];
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const ref = m[1];
    if (!/^(?:https?:|data:|#|mailto:)/.test(ref)) refs.push(ref);
  }
  return refs;
}

function verifyPackage(manifests) {
  const packaged = new Set([...PACKAGE_FILES, 'manifest.json']);
  const problems = [];

  for (const f of PACKAGE_FILES) {
    if (!fs.existsSync(path.join(ROOT, f))) problems.push(`missing on disk: ${f}`);
  }
  for (const [target, m] of Object.entries(manifests)) {
    for (const f of manifestFiles(m)) {
      if (!packaged.has(f)) problems.push(`${target} manifest references ${f}, which the package does not include`);
    }
  }
  const optionsHtml = fs.readFileSync(path.join(ROOT, 'options.html'), 'utf8');
  for (const f of htmlFiles(optionsHtml)) {
    if (!packaged.has(f)) problems.push(`options.html references ${f}, which the package does not include`);
  }

  if (problems.length > 0) {
    throw new Error('Package is inconsistent:\n  - ' + problems.join('\n  - '));
  }
}

// ---------------------------------------------------------------------------
// Zip writer
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// Fixed 1980-01-01, the earliest a DOS timestamp can express, so two builds of
// the same source produce byte-identical zips.
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;

function zip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const deflated = zlib.deflateRawSync(entry.data, { level: 9 });
    // Storing is smaller for the already-compressed PNGs.
    const compressed = deflated.length < entry.data.length;
    const body = compressed ? deflated : entry.data;
    const method = compressed ? 8 : 0;

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    chunks.push(local, body);

    const dir = Buffer.alloc(46 + name.length);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(DOS_TIME, 12);
    dir.writeUInt16LE(DOS_DATE, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(entry.data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt16LE(0, 30);
    dir.writeUInt16LE(0, 32);
    dir.writeUInt16LE(0, 34);
    dir.writeUInt16LE(0, 36);
    dir.writeUInt32LE(0, 38);
    dir.writeUInt32LE(offset, 42);
    name.copy(dir, 46);
    central.push(dir);

    offset += local.length + body.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, directory, end]);
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function buildTarget(target, manifest) {
  const outDir = path.join(DIST, target);
  rmrf(outDir);
  fs.mkdirSync(path.join(outDir, 'icons'), { recursive: true });

  const manifestJson = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  const entries = [{ name: 'manifest.json', data: manifestJson }];
  for (const f of PACKAGE_FILES) {
    entries.push({ name: f, data: fs.readFileSync(path.join(ROOT, f)) });
  }

  for (const entry of entries) {
    fs.writeFileSync(path.join(outDir, entry.name), entry.data);
  }

  const zipName = `reelhop-${target}-${manifest.version}.zip`;
  const zipPath = path.join(DIST, zipName);
  fs.writeFileSync(zipPath, zip(entries));

  return { target, outDir, zipPath, zipName, entries: entries.length, bytes: fs.statSync(zipPath).size };
}

function build() {
  const chrome = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const firefox = firefoxManifest(chrome);

  verifyPackage({ chrome, firefox });
  fs.mkdirSync(DIST, { recursive: true });

  return [buildTarget('chrome', chrome), buildTarget('firefox', firefox)];
}

if (require.main === module) {
  try {
    for (const r of build()) {
      console.log(`${r.target.padEnd(8)} ${r.entries} files  ${String(r.bytes).padStart(7)} bytes  dist/${r.zipName}`);
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

module.exports = { build, firefoxManifest, manifestFiles, htmlFiles, zip, crc32, PACKAGE_FILES, GECKO };
