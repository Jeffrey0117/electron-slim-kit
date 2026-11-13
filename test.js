'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const kit = require('./index.js')

// ── fixtures ──

function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-slim-'))
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n')
  }
  return dir
}

const installed = (name, dependencies = {}, body = 'x'.repeat(1000)) => ({
  [`node_modules/${name}/package.json`]: { name, version: '1.0.0', dependencies },
  [`node_modules/${name}/index.js`]: body,
})

/** Build a minimal asar archive holding the given { path: size } entries. */
function writeAsar(file, sizes) {
  const table = { files: {} }
  let offset = 0
  for (const [entryPath, size] of Object.entries(sizes)) {
    const parts = entryPath.split('/')
    let node = table
    for (const part of parts.slice(0, -1)) {
      node.files[part] = node.files[part] ?? { files: {} }
      node = node.files[part]
    }
    node.files[parts[parts.length - 1]] = { size, offset: String(offset) }
    offset += size
  }
  const json = Buffer.from(JSON.stringify(table), 'utf8')
  const padded = Math.ceil(json.length / 4) * 4
  const header = Buffer.alloc(8 + padded)
  header.writeUInt32LE(4 + padded, 0)
  header.writeUInt32LE(json.length, 4)
  json.copy(header, 8)
  const sizes8 = Buffer.alloc(8)
  sizes8.writeUInt32LE(4, 0)
  sizes8.writeUInt32LE(header.length, 4)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.concat([sizes8, header, Buffer.alloc(offset)]))
}

const UNBUNDLED_MAIN = {
  'package.json': {
    name: 'photo-app',
    version: '1.2.3',
    main: 'electron/main.cjs',
    dependencies: { sharp: '^1', react: '^18', 'react-dom': '^18' },
    devDependencies: { 'electron-builder': '^26', vite: '^5' },
    build: { files: ['dist/**/*', 'electron/**/*'], directories: { output: 'release' } },
  },
  'electron/main.cjs': "const { app } = require('electron')\nconst fs = require('node:fs')\nrequire('./lib/images.cjs')\n",
  'electron/lib/images.cjs': "const sharp = require('sharp')\nmodule.exports = sharp\n",
  ...installed('sharp', { color: '^1', shared: '^1' }),
  ...installed('color'),
  ...installed('shared'),
  ...installed('react', { 'loose-envify': '^1', shared: '^1' }),
  ...installed('react-dom', { scheduler: '^1' }),
  ...installed('loose-envify'),
  ...installed('scheduler'),
}

// ── audit ──

test('separates what the main process loads from what only the renderer uses', () => {
  const audit = kit.auditProject(project(UNBUNDLED_MAIN))
  assert.deepEqual(audit.neededByMain, ['sharp'])
  assert.deepEqual(audit.notLoadedByMain, ['react', 'react-dom'])
  assert.equal(audit.mainEntry, path.join('electron', 'main.cjs'))
  assert.equal(audit.builder, 'electron-builder')
})

test('follows local files from the entry point instead of scanning folders', () => {
  const dir = project({
    ...UNBUNDLED_MAIN,
    // never imported by the main process — must not count
    'electron/unused.cjs': "require('react')\n",
  })
  assert.deepEqual(kit.auditProject(dir).neededByMain, ['sharp'])
})

test('keeps a package both sides depend on, and drops only what nothing kept needs', () => {
  const audit = kit.auditProject(project(UNBUNDLED_MAIN))
  assert.deepEqual(audit.keepPackages, ['color', 'shared', 'sharp'])
  assert.deepEqual(audit.dropPackages, ['loose-envify', 'react', 'react-dom', 'scheduler'])
  assert.ok(audit.dropBytes > 4000 && audit.dropBytes < 6000, `dropBytes=${audit.dropBytes}`)
})

test('ignores imports that only appear in comments, and builtins and electron', () => {
  const dir = project({
    ...UNBUNDLED_MAIN,
    'electron/main.cjs': [
      "// const old = require('react')",
      "/* import x from 'react-dom' */",
      "const s = 'not a // comment'; const sharp = require('sharp')",
      "const path = require('path'); const { app } = require('electron/main')",
      "const t = require('node:timers/promises')",
    ].join('\n'),
  })
  const audit = kit.auditProject(dir)
  assert.deepEqual(audit.neededByMain, ['sharp'])
  assert.deepEqual(audit.undeclared, [])
})

test('understands ESM imports, subpaths and scoped packages', () => {
  const dir = project({
    'package.json': {
      name: 'esm-app',
      main: 'main.mjs',
      dependencies: { '@scope/pkg': '^1', lodash: '^4', left: '^1', unused: '^1' },
      devDependencies: { 'electron-builder': '^26' },
    },
    'main.mjs': "import a from '@scope/pkg/sub/path.js'\nimport { x } from \"lodash/fp\"\nexport * from './more.mjs'\n",
    'more.mjs': "const m = await import('left')\n",
  })
  assert.deepEqual(kit.auditProject(dir).neededByMain, ['@scope/pkg', 'lodash', 'left'])
})

test('follows a preload script, which is started by path rather than imported', () => {
  const dir = project({
    ...UNBUNDLED_MAIN,
    'electron/main.cjs': "const path = require('path')\nnew BrowserWindow({ webPreferences: { preload: path.join(__dirname, 'preload.cjs') } })\n",
    'electron/preload.cjs': "const dom = require('react-dom')\n",
  })
  const audit = kit.auditProject(dir)
  assert.deepEqual(audit.preloads, [path.join('electron', 'preload.cjs')])
  assert.deepEqual(audit.neededByMain, ['react-dom'])
})

test('counts loads it cannot read statically, so the caller knows the audit may be incomplete', () => {
  const dir = project({ ...UNBUNDLED_MAIN, 'electron/main.cjs': 'const name = pick()\nconst mod = require(name)\nrequire(`./plugins/${name}`)\n' })
  assert.equal(kit.auditProject(dir).dynamicLoads, 2)
})

test('reports a package the main process loads that is not a production dependency', () => {
  const dir = project({ ...UNBUNDLED_MAIN, 'electron/main.cjs': "require('scheduler')\n" })
  assert.deepEqual(kit.auditProject(dir).undeclared, ['scheduler'])
})

test('a loaded package that is not installed is still required, and verify fails without it', () => {
  // Real case: package.json gained a dependency, node_modules was never updated,
  // the packer silently left it out — and a check that only knew about installed
  // packages reported the archive as correct.
  const files = { ...UNBUNDLED_MAIN }
  delete files['node_modules/sharp/package.json']
  delete files['node_modules/sharp/index.js']
  const dir = project(files)
  const audit = kit.auditProject(dir)

  assert.deepEqual(audit.neededByMain, ['sharp'])
  assert.deepEqual(audit.notInstalled, ['sharp'])
  assert.ok(audit.keepPackages.includes('sharp'))

  const asar = path.join(dir, 'release', 'win-unpacked', 'resources', 'app.asar')
  writeAsar(asar, { 'package.json': 10 })
  const result = kit.verifyPackage(asar, audit)
  assert.deepEqual(result.missing, ['sharp'])
  assert.equal(result.ok, false)
})

test('refuses to guess when the main entry has not been built', () => {
  const dir = project({ 'package.json': { name: 'x', main: 'dist-electron/main.js', dependencies: {} } })
  assert.throws(() => kit.auditProject(dir), /does not exist.*build the app first/s)
})

test('accepts extra entry files and reads the main entry from build.extraMetadata', () => {
  const dir = project({
    'package.json': {
      name: 'x',
      main: 'src/dev-entry.js',
      dependencies: { a: '^1', b: '^1' },
      build: { extraMetadata: { main: 'out/main.cjs' } },
    },
    'src/dev-entry.js': "require('nothing-relevant')\n",
    'out/main.cjs': "require('a')\n",
    'out/worker.cjs': "require('b')\n",
  })
  assert.deepEqual(kit.auditProject(dir).neededByMain, ['a'])
  assert.deepEqual(kit.auditProject(dir, { entries: ['out/worker.cjs'] }).neededByMain, ['a', 'b'])
})

// ── fix ──

test('moves renderer-only packages to devDependencies when the main process needs others', () => {
  const dir = project(UNBUNDLED_MAIN)
  const plan = kit.planFix(kit.auditProject(dir))
  assert.equal(plan.kind, 'move-to-dev')

  const before = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const snapshot = JSON.stringify(before)
  const after = plan.apply(before)

  assert.equal(JSON.stringify(before), snapshot, 'input must not be mutated')
  assert.deepEqual(after.dependencies, { sharp: '^1' })
  assert.deepEqual(Object.keys(after.devDependencies), ['electron-builder', 'react', 'react-dom', 'vite'])
  assert.equal(after.devDependencies.react, '^18')
})

test('excludes node_modules entirely when the main process is a self-contained bundle', () => {
  const dir = project({
    'package.json': {
      name: 'bundled',
      main: 'dist-electron/main.cjs',
      dependencies: { react: '^18', ws: '^8' },
      devDependencies: { 'electron-builder': '^26' },
      build: { files: ['dist-electron/**/*'] },
    },
    'dist-electron/main.cjs': "const { app } = require('electron')\nconst http = require('http')\n",
  })
  const plan = kit.planFix(kit.auditProject(dir))
  assert.equal(plan.kind, 'exclude-all')

  const after = plan.apply(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')))
  assert.deepEqual(after.build.files, ['dist-electron/**/*', '!node_modules/**/*'])
  assert.equal(after.build.npmRebuild, false)
  assert.deepEqual(Object.keys(after.dependencies), ['react', 'ws'], 'dependencies stay; they are just not shipped')

  // applying twice must not add the pattern twice
  assert.deepEqual(plan.apply(after).build.files, ['dist-electron/**/*', '!node_modules/**/*'])
})

test('has nothing to do when every dependency is loaded, or under Electron Forge', () => {
  const allUsed = project({ ...UNBUNDLED_MAIN, 'electron/main.cjs': "require('sharp'); require('react'); require('react-dom')\n" })
  assert.equal(kit.planFix(kit.auditProject(allUsed)).kind, 'none')

  const forge = project({
    ...UNBUNDLED_MAIN,
    'package.json': { ...UNBUNDLED_MAIN['package.json'], devDependencies: { '@electron-forge/cli': '^7' } },
  })
  assert.equal(kit.planFix(kit.auditProject(forge)).kind, 'none')
})

test('writes package.json keeping its indentation, line endings and final newline', () => {
  const dir = project(UNBUNDLED_MAIN)
  const file = path.join(dir, 'package.json')
  const fourSpacesCrlf = JSON.stringify(UNBUNDLED_MAIN['package.json'], null, 4).split('\n').join('\r\n') + '\r\n'
  fs.writeFileSync(file, fourSpacesCrlf)

  const result = kit.applyFix(dir, kit.planFix(kit.auditProject(dir)))
  const written = fs.readFileSync(file, 'utf8')

  assert.equal(result.written, true)
  assert.match(written, /^\{\r\n {4}"name"/)
  assert.ok(written.endsWith('}\r\n'))
  assert.ok(!/[^\r]\n/.test(written), 'no bare LF introduced')
  assert.deepEqual(JSON.parse(written).dependencies, { sharp: '^1' })

  // a second run changes nothing and reports so
  assert.equal(kit.applyFix(dir, kit.planFix(kit.auditProject(dir))).written, false)
})

// ── packed app ──

test('reads what an app.asar contains', () => {
  const dir = project({})
  const asar = path.join(dir, 'release', 'win-unpacked', 'resources', 'app.asar')
  writeAsar(asar, {
    'package.json': 100,
    'dist/index.js': 900,
    'node_modules/sharp/index.js': 5000,
    'node_modules/sharp/lib/a.js': 1000,
    'node_modules/@scope/pkg/index.js': 300,
  })
  const inspection = kit.inspectAsar(asar)
  assert.equal(inspection.files, 5)
  assert.equal(inspection.appBytes, 1000)
  assert.equal(inspection.packageBytes, 6300)
  assert.deepEqual(inspection.packages, { sharp: { files: 2, bytes: 6000 }, '@scope/pkg': { files: 1, bytes: 300 } })
  assert.equal(kit.findPackedAsar(dir), asar)
})

test('flags packages that shipped for nothing, and ones the app needs that are absent', () => {
  const dir = project(UNBUNDLED_MAIN)
  const audit = kit.auditProject(dir)
  const asar = path.join(dir, 'release', 'win-unpacked', 'resources', 'app.asar')

  writeAsar(asar, { 'node_modules/sharp/i.js': 10, 'node_modules/color/i.js': 10, 'node_modules/shared/i.js': 10, 'node_modules/react/i.js': 700 })
  const bloated = kit.verifyPackage(asar, audit)
  assert.equal(bloated.ok, false)
  assert.deepEqual(bloated.unexpected, ['react'])
  assert.equal(bloated.unexpectedBytes, 700)

  // a transitive package the packager left out is reported, but is not a failure
  writeAsar(asar, { 'node_modules/sharp/i.js': 10, 'node_modules/color/i.js': 10 })
  const pruned = kit.verifyPackage(asar, audit)
  assert.deepEqual(pruned.missingTransitive, ['shared'])
  assert.deepEqual(pruned.missing, [])
  assert.equal(pruned.ok, true)

  // a package the main process loads directly being absent IS a failure
  writeAsar(asar, { 'node_modules/color/i.js': 10, 'node_modules/shared/i.js': 10 })
  const broken = kit.verifyPackage(asar, audit)
  assert.deepEqual(broken.missing, ['sharp'])
  assert.equal(broken.ok, false)

  // …unless it is a native module unpacked next to the archive
  fs.mkdirSync(`${asar}.unpacked/node_modules/sharp`, { recursive: true })
  assert.equal(kit.verifyPackage(asar, audit).ok, true)
})

// ── the build packing its own output ──

const SELF_PACKING = {
  'package.json': {
    name: 'viewer',
    main: 'electron/main.cjs',
    dependencies: {},
    devDependencies: { 'electron-builder': '^26', vite: '^5' },
    // vite writes to dist/, and electron-builder's default output is dist/ too
    build: { files: ['dist/**/*', 'electron/**/*'] },
  },
  'electron/main.cjs': "require('electron')\n",
}

test('notices when the packager output folder is itself packed into the app', () => {
  const audit = kit.auditProject(project(SELF_PACKING))
  assert.equal(audit.outputDir, 'dist')
  assert.equal(audit.outputPackedIntoApp, true)

  const separate = project({
    ...SELF_PACKING,
    'package.json': { ...SELF_PACKING['package.json'], build: { files: ['dist/**/*'], directories: { output: 'release' } } },
  })
  assert.equal(kit.auditProject(separate).outputPackedIntoApp, false)

  const excluded = project({
    ...SELF_PACKING,
    'package.json': { ...SELF_PACKING['package.json'], build: { files: ['electron/**/*', '!dist/**/*'] } },
  })
  assert.equal(kit.auditProject(excluded).outputPackedIntoApp, false)
})

test('moves the packager output to a folder nothing packs, on top of any dependency fix', () => {
  const dir = project(SELF_PACKING)
  const plan = kit.planFix(kit.auditProject(dir))
  assert.equal(plan.kind, 'move-output')
  const after = plan.apply(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')))
  assert.equal(after.build.directories.output, 'release')
  assert.deepEqual(after.build.files, ['dist/**/*', 'electron/**/*'])

  // combined with a dependency fix, and avoiding a name that build.files already uses
  const both = project({
    ...SELF_PACKING,
    'package.json': {
      ...SELF_PACKING['package.json'],
      dependencies: { react: '^18' },
      build: { files: ['dist/**/*', 'release/**/*'] },
    },
  })
  const combined = kit.planFix(kit.auditProject(both))
  assert.equal(combined.kind, 'exclude-all')
  assert.equal(combined.movesOutput, true)
  const merged = combined.apply(JSON.parse(fs.readFileSync(path.join(both, 'package.json'), 'utf8')))
  assert.equal(merged.build.directories.output, 'release-app')
  assert.ok(merged.build.files.includes('!node_modules/**/*'))
})

test('verify fails when a previous build is packed inside the archive', () => {
  const dir = project(SELF_PACKING)
  const audit = kit.auditProject(dir)
  const asar = path.join(dir, 'dist', 'win-unpacked', 'resources', 'app.asar')

  writeAsar(asar, {
    'dist/index.html': 500,
    'dist/win-unpacked/electron.exe': 180_000_000,
    'dist/win-unpacked/resources/app.asar': 1_000_000,
    'electron/main.cjs': 300,
  })
  const nested = kit.verifyPackage(asar, audit)
  assert.equal(nested.ok, false)
  assert.deepEqual(nested.nestedOutput.folders, ['dist/win-unpacked'])
  assert.equal(nested.nestedOutput.bytes, 181_000_000)

  writeAsar(asar, { 'dist/index.html': 500, 'electron/main.cjs': 300 })
  const clean = kit.verifyPackage(asar, audit)
  assert.equal(clean.nestedOutput.bytes, 0)
  assert.equal(clean.ok, true)
})

test('says so plainly when the file is not an asar archive', () => {
  const dir = project({ 'not.asar': 'hello' })
  assert.throws(() => kit.inspectAsar(path.join(dir, 'not.asar')), /not a readable asar archive/)
})
