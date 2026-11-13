'use strict'

/**
 * electron-slim-kit
 *
 * An Electron installer ships every package listed under `dependencies`, whether
 * or not anything loads it at run time. When the renderer is bundled (vite,
 * esbuild, webpack…) its packages are already inside the bundle — listing them
 * under `dependencies` ships them a second time, unbundled, for nothing.
 *
 * This kit answers three questions, without running the app:
 *   audit   — which production dependencies does the main process really load?
 *   fix     — what is the smallest package.json change that stops shipping the rest?
 *   verify  — does the packed app.asar now contain only what it should?
 *
 * Zero dependencies. Nothing here executes project code.
 */

const fs = require('fs')
const path = require('path')
const { builtinModules } = require('module')

const BUILTINS = new Set(builtinModules)
const SOURCE_EXTENSIONS = ['.js', '.cjs', '.mjs', '.ts', '.cts', '.mts']
const RESOLVE_EXTENSIONS = [...SOURCE_EXTENSIONS, '.json', '.node']
const PACKAGE_NAME = /^(?:@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/
const EXCLUDE_ALL_PATTERN = '!node_modules/**/*'

// ───────────────────────── source scanning ─────────────────────────

/** Remove comments so text inside them is not mistaken for an import. Strings are kept. */
function stripComments(source) {
  let out = ''
  let i = 0
  let quote = null
  while (i < source.length) {
    const ch = source[i]
    const next = source[i + 1]
    if (quote) {
      out += ch
      if (ch === '\\') {
        out += next ?? ''
        i += 2
        continue
      }
      if (ch === quote) quote = null
      i += 1
    } else if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      out += ch
      i += 1
    } else if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1
    } else if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      i = end === -1 ? source.length : end + 2
    } else {
      out += ch
      i += 1
    }
  }
  return out
}

/** Module specifiers a file loads, plus how many loads could not be read statically. */
function scanSource(source) {
  const code = stripComments(source)
  const specifiers = [
    ...code.matchAll(/\brequire\(\s*(['"`])([^'"`$]+)\1\s*\)/g),
    ...code.matchAll(/\bimport\(\s*(['"`])([^'"`$]+)\1\s*\)/g),
    ...code.matchAll(/\b(?:import|export)\s[^'"`;]*?\bfrom\s*(['"])([^'"]+)\1/g),
    ...code.matchAll(/\bimport\s*(['"])([^'"]+)\1/g),
  ].map((m) => m[2])

  const dynamic =
    [...code.matchAll(/\brequire\(\s*(?!['"`])[^)\s]/g)].length +
    [...code.matchAll(/\brequire\(\s*`[^`]*\$\{/g)].length

  const preloads = [...code.matchAll(/(['"`])([^'"`\n]*preload[^'"`\n]*\.(?:c|m)?js)\1/gi)].map((m) => m[2])

  return { specifiers: [...new Set(specifiers)], dynamic, preloads: [...new Set(preloads)] }
}

function packageNameOf(specifier) {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/** Resolve a relative specifier the way Node (and a TS build) would, or null. */
function resolveLocal(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier)
  const withoutJs = base.replace(/\.(c|m)?js$/, '')
  const candidates = [
    base,
    ...RESOLVE_EXTENSIONS.map((ext) => base + ext),
    // TypeScript sources import './x.js' and mean './x.ts'
    ...SOURCE_EXTENSIONS.map((ext) => withoutJs + ext),
    ...RESOLVE_EXTENSIONS.map((ext) => path.join(base, 'index' + ext)),
  ]
  return candidates.find(isFile) ?? null
}

// ───────────────────────── dependency closure ─────────────────────────

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))
  } catch {
    return null
  }
}

/** Every installed package reachable from `names` through dependencies / optionalDependencies. */
function dependencyClosure(projectDir, names) {
  const seen = new Set()
  const stack = [...names]
  while (stack.length > 0) {
    const name = stack.pop()
    if (seen.has(name)) continue
    const manifest = readJson(path.join(projectDir, 'node_modules', name, 'package.json'))
    if (!manifest) continue // not installed (an optional dependency for another platform, usually)
    seen.add(name)
    stack.push(...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {}))
  }
  return seen
}

function directorySize(dir) {
  let total = 0
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    let stat
    try {
      stat = fs.lstatSync(current)
    } catch {
      continue
    }
    if (stat.isSymbolicLink()) continue
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) stack.push(path.join(current, entry))
    } else {
      total += stat.size
    }
  }
  return total
}

function sizeOfPackages(projectDir, names) {
  let total = 0
  for (const name of names) total += directorySize(path.join(projectDir, 'node_modules', name))
  return total
}

// ───────────────────────── audit ─────────────────────────

function detectBuilder(pkg) {
  const all = { ...pkg.dependencies, ...pkg.devDependencies }
  if (all['electron-builder']) return 'electron-builder'
  if (Object.keys(all).some((name) => name.startsWith('@electron-forge/'))) return 'electron-forge'
  return null
}

function mainEntryOf(pkg) {
  return pkg.build?.extraMetadata?.main ?? pkg.main ?? 'index.js'
}

/**
 * Work out which production dependencies the Electron main process (and its
 * preload scripts) load at run time, by following imports from the entry point.
 *
 * @param {string} projectDir
 * @param {{ entries?: string[] }} [opts]  extra entry files, relative to projectDir
 *        (worker scripts, utility processes — anything started by path).
 */
function auditProject(projectDir, opts = {}) {
  const root = path.resolve(projectDir)
  const pkg = readJson(path.join(root, 'package.json'))
  if (!pkg) throw new Error(`No readable package.json in ${root}`)

  const mainEntry = path.resolve(root, mainEntryOf(pkg))
  if (!isFile(mainEntry)) {
    throw new Error(
      `Main entry ${path.relative(root, mainEntry)} does not exist. ` +
        `If it is build output, build the app first — the audit reads what actually ships.`,
    )
  }

  const queue = [mainEntry, ...(opts.entries ?? []).map((e) => path.resolve(root, e))]
  const visited = new Set()
  const usage = new Map() // package → files that load it
  const preloads = new Set()
  let dynamicLoads = 0

  while (queue.length > 0) {
    const file = queue.pop()
    if (visited.has(file) || !isFile(file)) continue
    visited.add(file)
    if (!SOURCE_EXTENSIONS.includes(path.extname(file))) continue

    const scan = scanSource(fs.readFileSync(file, 'utf8'))
    dynamicLoads += scan.dynamic

    for (const specifier of scan.specifiers) {
      if (specifier.startsWith('.') || path.isAbsolute(specifier)) {
        const resolved = resolveLocal(file, specifier)
        if (resolved) queue.push(resolved)
        continue
      }
      const bare = specifier.replace(/^node:/, '')
      if (specifier.startsWith('node:') || BUILTINS.has(bare) || BUILTINS.has(packageNameOf(bare))) continue
      const name = packageNameOf(bare)
      if (name === 'electron' || !PACKAGE_NAME.test(name)) continue
      usage.set(name, [...(usage.get(name) ?? []), path.relative(root, file)])
    }

    // A preload script is started by path, not by import — follow it too.
    for (const candidate of scan.preloads) {
      const basename = path.basename(candidate)
      const found = [path.resolve(path.dirname(file), candidate), path.resolve(path.dirname(file), basename), path.resolve(root, candidate)].find(isFile)
      if (found && !visited.has(found)) {
        preloads.add(path.relative(root, found))
        queue.push(found)
      }
    }
  }

  const declared = Object.keys(pkg.dependencies ?? {})
  const installed = fs.existsSync(path.join(root, 'node_modules'))
  const neededByMain = declared.filter((name) => usage.has(name))
  const notLoadedByMain = declared.filter((name) => !usage.has(name))
  // Loaded but not declared: either a devDependency (works in dev, missing once packed) or transitive.
  const undeclared = [...usage.keys()].filter(
    (name) => !declared.includes(name) && fs.existsSync(path.join(root, 'node_modules', name)),
  )

  // A package the main process loads is needed whether or not it is installed
  // here. Leaving it out because node_modules is stale would make a later
  // `verify` pass on an app that cannot start.
  const direct = [...neededByMain, ...undeclared]
  const notInstalled = installed ? direct.filter((name) => !fs.existsSync(path.join(root, 'node_modules', name))) : []
  const keep = new Set([...direct, ...dependencyClosure(root, direct)])
  const drop = new Set([...dependencyClosure(root, notLoadedByMain)].filter((name) => !keep.has(name)))

  return {
    name: pkg.name ?? path.basename(root),
    version: pkg.version ?? '',
    projectDir: root,
    builder: detectBuilder(pkg),
    mainEntry: path.relative(root, mainEntry),
    preloads: [...preloads].sort(),
    scannedFiles: visited.size,
    dynamicLoads,
    installed,
    neededByMain,
    notLoadedByMain,
    undeclared,
    notInstalled,
    usage: Object.fromEntries([...usage.entries()].map(([name, files]) => [name, [...new Set(files)]])),
    keepPackages: [...keep].sort(),
    dropPackages: [...drop].sort(),
    keepBytes: installed ? sizeOfPackages(root, keep) : null,
    dropBytes: installed ? sizeOfPackages(root, drop) : null,
  }
}

// ───────────────────────── fix ─────────────────────────

function sortKeys(object) {
  return Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)))
}

/**
 * The smallest package.json change that stops shipping what the main process
 * never loads. Pure: returns a description and a function producing a NEW
 * package.json object — nothing is written and the input is not modified.
 */
function planFix(audit) {
  const none = (reason) => ({ kind: 'none', reason, changes: [], apply: (pkg) => pkg })

  if (audit.notLoadedByMain.length === 0) return none('Every production dependency is loaded by the main process.')
  if (audit.builder === 'electron-forge') {
    return none('Electron Forge with a bundler plugin ships the bundle, not node_modules — check the packed app with `verify` instead.')
  }

  const nothingNeeded = audit.neededByMain.length === 0 && audit.undeclared.length === 0

  if (nothingNeeded && audit.builder === 'electron-builder') {
    return {
      kind: 'exclude-all',
      reason: 'The main process loads no package at run time, so node_modules does not need to ship at all.',
      changes: [`build.files: add "${EXCLUDE_ALL_PATTERN}"`, 'build.npmRebuild: false (no native module is packaged any more)'],
      apply: (pkg) => {
        const files = pkg.build?.files ?? ['**/*']
        return {
          ...pkg,
          build: {
            ...pkg.build,
            files: files.includes(EXCLUDE_ALL_PATTERN) ? files : [...files, EXCLUDE_ALL_PATTERN],
            npmRebuild: false,
          },
        }
      },
    }
  }

  const moving = audit.notLoadedByMain
  return {
    kind: 'move-to-dev',
    reason: 'These packages are only used by bundled code; as devDependencies they are still bundled but no longer shipped unbundled.',
    changes: moving.map((name) => `${name}: dependencies → devDependencies`),
    apply: (pkg) => {
      const dependencies = { ...pkg.dependencies }
      const moved = {}
      for (const name of moving) {
        if (dependencies[name] === undefined) continue
        moved[name] = dependencies[name]
        delete dependencies[name]
      }
      return { ...pkg, dependencies, devDependencies: sortKeys({ ...pkg.devDependencies, ...moved }) }
    },
  }
}

/** Write a plan to package.json, keeping the file's indentation, line endings and final newline. */
function applyFix(projectDir, plan) {
  const file = path.join(path.resolve(projectDir), 'package.json')
  const raw = fs.readFileSync(file, 'utf8')
  const bom = raw.startsWith('﻿') ? '﻿' : ''
  const text = raw.slice(bom.length)
  const before = JSON.parse(text)
  const after = plan.apply(before)
  if (JSON.stringify(after) === JSON.stringify(before)) return { written: false, file }

  const indent = text.match(/^[ \t]+(?=")/m)?.[0] ?? '  '
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const body = JSON.stringify(after, null, indent).split('\n').join(eol)
  fs.writeFileSync(file, bom + body + (text.endsWith('\n') ? eol : ''), 'utf8')
  return { written: true, file }
}

// ───────────────────────── packed app (asar) ─────────────────────────

/**
 * Read an asar archive's file table. The format is a small header (two
 * Chromium "pickles") followed by the file contents; the table is JSON.
 */
function readAsarEntries(asarPath) {
  const fd = fs.openSync(asarPath, 'r')
  try {
    const sizes = Buffer.alloc(8)
    if (fs.readSync(fd, sizes, 0, 8, 0) !== 8) throw new Error('too short')
    const headerSize = sizes.readUInt32LE(4)
    const header = Buffer.alloc(headerSize)
    if (fs.readSync(fd, header, 0, headerSize, 8) !== headerSize) throw new Error('truncated header')
    const jsonLength = header.readUInt32LE(4)
    const table = JSON.parse(header.subarray(8, 8 + jsonLength).toString('utf8'))

    const entries = []
    const walk = (node, prefix) => {
      for (const [name, child] of Object.entries(node.files ?? {})) {
        const full = prefix ? `${prefix}/${name}` : name
        if (child.files) walk(child, full)
        else entries.push({ path: full, size: Number(child.size ?? 0), unpacked: child.unpacked === true })
      }
    }
    walk(table, '')
    return entries
  } catch (error) {
    throw new Error(`${asarPath} is not a readable asar archive (${error.message})`)
  } finally {
    fs.closeSync(fd)
  }
}

/** What a packed app.asar contains: totals and the top-level packages under node_modules. */
function inspectAsar(asarPath) {
  const entries = readAsarEntries(asarPath)
  const packages = new Map()
  let appBytes = 0
  let unpackedBytes = 0
  for (const entry of entries) {
    // Unpacked entries are listed in the table but stored next to the archive.
    if (entry.unpacked) unpackedBytes += entry.size
    const match = entry.path.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)\//)
    if (!match) {
      appBytes += entry.size
      continue
    }
    const current = packages.get(match[1]) ?? { files: 0, bytes: 0 }
    packages.set(match[1], { files: current.files + 1, bytes: current.bytes + entry.size })
  }
  return {
    asarPath,
    fileBytes: fs.statSync(asarPath).size,
    files: entries.length,
    appBytes,
    unpackedBytes,
    packageBytes: [...packages.values()].reduce((sum, p) => sum + p.bytes, 0),
    packages: Object.fromEntries([...packages.entries()].sort((a, b) => b[1].bytes - a[1].bytes)),
  }
}

/** Newest app.asar under the usual output folders, or null. */
function findPackedAsar(projectDir) {
  const root = path.resolve(projectDir)
  const found = []
  for (const outDir of ['release', 'dist', 'out', 'dist-app', 'build']) {
    let children
    try {
      children = fs.readdirSync(path.join(root, outDir))
    } catch {
      continue
    }
    for (const child of children) {
      const candidate = path.join(root, outDir, child, 'resources', 'app.asar')
      if (isFile(candidate)) found.push(candidate)
    }
  }
  return found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] ?? null
}

/**
 * Compare a packed app.asar with the audit.
 *
 *   unexpected        shipped although nothing the main process loads needs them
 *   missing           a package the main process loads directly is not packed —
 *                     the app will fail when that code runs
 *   missingTransitive a dependency of one of those is not packed. Usually the
 *                     packager pruned it on purpose (type-only packages, other
 *                     platforms' binaries), so it is reported but does not fail.
 *
 * Native modules unpacked next to the archive (app.asar.unpacked) count as present.
 */
function verifyPackage(asarPath, audit) {
  const inspection = inspectAsar(asarPath)
  const shipped = Object.keys(inspection.packages)
  const keep = new Set(audit.keepPackages)

  const unpackedDir = `${asarPath}.unpacked`
  const unpacked = new Set()
  try {
    for (const name of fs.readdirSync(path.join(unpackedDir, 'node_modules'))) {
      if (!name.startsWith('@')) unpacked.add(name)
      else for (const sub of fs.readdirSync(path.join(unpackedDir, 'node_modules', name))) unpacked.add(`${name}/${sub}`)
    }
  } catch {
    // no unpacked modules
  }

  const direct = new Set([...audit.neededByMain, ...audit.undeclared])
  const absent = audit.keepPackages.filter((name) => !shipped.includes(name) && !unpacked.has(name))
  const unexpected = shipped.filter((name) => !keep.has(name))
  const missing = absent.filter((name) => direct.has(name))
  return {
    ok: unexpected.length === 0 && missing.length === 0,
    unexpected,
    unexpectedBytes: unexpected.reduce((sum, name) => sum + inspection.packages[name].bytes, 0),
    missing,
    missingTransitive: absent.filter((name) => !direct.has(name)),
    inspection,
  }
}

module.exports = {
  auditProject,
  planFix,
  applyFix,
  inspectAsar,
  readAsarEntries,
  findPackedAsar,
  verifyPackage,
  // exported for tests and reuse
  scanSource,
  stripComments,
  dependencyClosure,
}
