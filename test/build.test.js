// Tests for build.js, run with:  node test/build.test.js
//
// Two things are worth covering here. The Firefox manifest is generated rather
// than hand-kept, so these check it really is the Chrome one with the two
// browsers' differences applied and nothing else changed. And the zip writer
// is hand-rolled — there is no `zip` on Windows and Compress-Archive writes
// backslash separators — so the archive is read back apart to prove a browser
// could actually open it.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const build = require('../build.js');
const ROOT = path.join(__dirname, '..');
const chromeManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}
const eq = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });

// ---- a just-enough zip reader, so the writer is checked by something that
// ---- did not write it ------------------------------------------------------
function readZip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('no end-of-central-directory record');
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error(`bad central header at ${at}`);
    const method = buf.readUInt16LE(at + 10);
    const csize = buf.readUInt32LE(at + 20);
    const usize = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const offset = buf.readUInt32LE(at + 42);
    const name = buf.slice(at + 46, at + 46 + nameLen).toString('utf8');

    if (buf.readUInt32LE(offset) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const localName = buf.readUInt16LE(offset + 26);
    const localExtra = buf.readUInt16LE(offset + 28);
    const start = offset + 30 + localName + localExtra;
    const body = buf.slice(start, start + csize);
    const data = method === 8 ? zlib.inflateRawSync(body) : body;
    if (data.length !== usize) throw new Error(`${name}: inflated ${data.length}, header said ${usize}`);
    files[name] = data;

    at += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

// =============================================================================
console.log('crc32');
// The standard check value from the zlib/PKZIP test vector.
eq('"123456789" hashes to the known CRC', build.crc32(Buffer.from('123456789')).toString(16), 'cbf43926');
eq('an empty buffer hashes to zero', build.crc32(Buffer.alloc(0)), 0);

console.log('firefoxManifest');
const ff = build.firefoxManifest(chromeManifest);
check('drops the service worker Firefox does not support', ff.background.service_worker === undefined);
eq('runs the same two files as a background page', ff.background.scripts, ['shared.js', 'background.js']);
check('loads shared.js first, since importScripts is worker-only',
  ff.background.scripts.indexOf('shared.js') < ff.background.scripts.indexOf('background.js'));
eq('declares a gecko id and a floor version', ff.browser_specific_settings.gecko,
  { id: build.GECKO.id, strict_min_version: build.GECKO.strict_min_version });
check('the floor is at least 115, where storage.session arrived',
  parseInt(ff.browser_specific_settings.gecko.strict_min_version, 10) >= 115);

// The drift this generation exists to prevent.
for (const key of ['manifest_version', 'name', 'version', 'description']) {
  eq(`${key} matches the Chrome manifest`, ff[key], chromeManifest[key]);
}
eq('host permissions are untouched', ff.host_permissions, chromeManifest.host_permissions);
eq('optional host permissions are untouched', ff.optional_host_permissions, chromeManifest.optional_host_permissions);
eq('content scripts are untouched', ff.content_scripts, chromeManifest.content_scripts);
eq('permissions are untouched', ff.permissions, chromeManifest.permissions);
eq('background is the only key that differs',
  Object.keys(ff).filter(k => k !== 'browser_specific_settings' && JSON.stringify(ff[k]) !== JSON.stringify(chromeManifest[k])),
  ['background']);

console.log('the Chrome manifest stays a service worker');
eq('still a service worker', chromeManifest.background, { service_worker: 'background.js' });
check('carries no gecko settings', chromeManifest.browser_specific_settings === undefined);

console.log('description length');
// The Chrome Web Store rejects an upload over 132; both packages share the field.
check(`is within the store limit (${chromeManifest.description.length} chars)`, chromeManifest.description.length <= 132,
  chromeManifest.description.length);

console.log('manifestFiles');
check('finds the worker in the Chrome shape', build.manifestFiles(chromeManifest).includes('background.js'));
check('finds both scripts in the Firefox shape',
  ['shared.js', 'background.js'].every(f => build.manifestFiles(ff).includes(f)));
check('every file a manifest names is packaged',
  build.manifestFiles(ff).every(f => f === 'manifest.json' || build.PACKAGE_FILES.includes(f)),
  build.manifestFiles(ff).filter(f => !build.PACKAGE_FILES.includes(f)));

console.log('htmlFiles');
const refs = build.htmlFiles(fs.readFileSync(path.join(ROOT, 'options.html'), 'utf8'));
check('picks up the script the manifest never mentions', refs.includes('options.js'));
check('picks up the stylesheet too', refs.includes('options.css'));
check('ignores links out to the web', !refs.some(r => r.startsWith('http')));

console.log('build');
const results = build.build();
eq('builds both targets', results.map(r => r.target), ['chrome', 'firefox']);

const expected = ['manifest.json', ...build.PACKAGE_FILES].sort();
for (const r of results) {
  const zipped = readZip(fs.readFileSync(r.zipPath));
  eq(`${r.target}: the zip holds exactly the package`, Object.keys(zipped).sort(), expected);
  check(`${r.target}: no backslash separators`, !Object.keys(zipped).some(n => n.includes('\\')),
    Object.keys(zipped).filter(n => n.includes('\\')));
  check(`${r.target}: the unpacked directory matches the zip`,
    Object.keys(zipped).every(n => fs.existsSync(path.join(r.outDir, n))));

  const inZip = JSON.parse(zipped['manifest.json'].toString('utf8'));
  eq(`${r.target}: the packaged manifest is this target's`,
    inZip.background, r.target === 'chrome' ? { service_worker: 'background.js' } : { scripts: ['shared.js', 'background.js'] });
  check(`${r.target}: a packaged script survives the round trip`,
    zipped['background.js'].equals(fs.readFileSync(path.join(ROOT, 'background.js'))));
  check(`${r.target}: the version is in the file name`, r.zipName.includes(chromeManifest.version));
}

console.log('reproducible');
const first = fs.readFileSync(results[1].zipPath);
build.build();
check('building twice produces an identical archive', first.equals(fs.readFileSync(results[1].zipPath)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
