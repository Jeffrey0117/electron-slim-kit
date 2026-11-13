#!/usr/bin/env node
'use strict'

const path = require('path')
const kit = require('./index.js')

const USAGE = `electron-slim — stop shipping packages your Electron app never loads

  electron-slim audit  <project> [--entry <file>]... [--json]
      Which production dependencies does the main process load, and which ship for nothing?

  electron-slim fix    <project> [--entry <file>]... [--write]
      Show the smallest package.json change. Nothing is written without --write.

  electron-slim verify <project> [--asar <app.asar>] [--entry <file>]... [--json]
      After packing: does app.asar contain only what the main process needs?
      Exit code 1 if something shipped for nothing or something needed is missing.

  --entry  an extra file started by path (worker, utility process), relative to the project.
           Preload scripts are found automatically.
`

function parse(argv) {
  const [command, ...rest] = argv
  const options = { entries: [], json: false, write: false, asar: null, project: null }
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === '--json') options.json = true
    else if (arg === '--write') options.write = true
    else if (arg === '--entry') options.entries.push(rest[++i])
    else if (arg === '--asar') options.asar = rest[++i]
    else if (!arg.startsWith('--') && !options.project) options.project = arg
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return { command, options }
}

const mb = (bytes) => (bytes === null ? 'not installed — size unknown' : `${(bytes / 1048576).toFixed(1)} MB`)
const list = (names) => (names.length > 0 ? names.join(', ') : '—')

function printAudit(audit) {
  const lines = [
    `${audit.name} ${audit.version}`.trim(),
    `  entry: ${audit.mainEntry}${audit.preloads.length > 0 ? `  (+ preload: ${audit.preloads.join(', ')})` : ''} — ${audit.scannedFiles} files followed`,
    `  loaded by the main process (${audit.neededByMain.length}): ${list(audit.neededByMain)}`,
    `      → ${audit.keepPackages.length} packages to ship, ${mb(audit.keepBytes)}`,
    `  shipped but never loaded (${audit.notLoadedByMain.length}): ${list(audit.notLoadedByMain)}`,
    `      → ${audit.dropPackages.length} packages only they need, ${mb(audit.dropBytes)}`,
  ]
  if (audit.undeclared.length > 0) {
    lines.push(`  ! loaded but not in dependencies: ${list(audit.undeclared)} — fine in dev, may be missing once packed`)
  }
  if (audit.dynamicLoads > 0) {
    lines.push(`  ! ${audit.dynamicLoads} load(s) use a computed name and could not be read — check those by hand before trusting this`)
  }
  if (!audit.installed) lines.push('  ! node_modules is not installed here, so sizes and transitive packages are unknown')
  console.log(lines.join('\n'))
}

function run(argv) {
  const { command, options } = parse(argv)
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE)
    return 0
  }
  if (!['audit', 'fix', 'verify'].includes(command)) throw new Error(`Unknown command: ${command}\n\n${USAGE}`)
  if (!options.project) throw new Error(`Which project?\n\n${USAGE}`)

  const audit = kit.auditProject(options.project, { entries: options.entries })

  if (command === 'audit') {
    if (options.json) console.log(JSON.stringify(audit, null, 2))
    else printAudit(audit)
    return 0
  }

  if (command === 'fix') {
    printAudit(audit)
    const plan = kit.planFix(audit)
    console.log(`\n  plan: ${plan.kind} — ${plan.reason}`)
    for (const change of plan.changes) console.log(`    • ${change}`)
    if (plan.kind === 'none') return 0
    if (!options.write) {
      console.log('\n  Nothing written. Re-run with --write to apply, then pack and run `electron-slim verify`.')
      return 0
    }
    const result = kit.applyFix(options.project, plan)
    console.log(result.written ? `\n  Wrote ${result.file}. Now pack the app and run \`electron-slim verify\`.` : '\n  Already applied — nothing to write.')
    return 0
  }

  const asar = options.asar ? path.resolve(options.asar) : kit.findPackedAsar(options.project)
  if (!asar) throw new Error('No packed app.asar found under release/, dist/, out/ — pack the app first, or pass --asar.')
  const result = kit.verifyPackage(asar, audit)
  if (options.json) {
    console.log(JSON.stringify(result, null, 2))
    return result.ok ? 0 : 1
  }
  const { inspection } = result
  console.log(`${audit.name}: ${path.relative(path.resolve(options.project), asar)}`)
  const unpackedNote = inspection.unpackedBytes > 0 ? ` + ${mb(inspection.unpackedBytes)} unpacked beside it` : ''
  console.log(`  ${mb(inspection.fileBytes)} archive${unpackedNote} — ${inspection.files} files, ${Object.keys(inspection.packages).length} packages`)
  if (result.unexpected.length > 0) {
    console.log(`  ✗ shipped for nothing (${result.unexpected.length} packages, ${mb(result.unexpectedBytes)}): ${result.unexpected.slice(0, 12).join(', ')}${result.unexpected.length > 12 ? ', …' : ''}`)
  }
  if (result.missing.length > 0) console.log(`  ✗ loaded by the main process but not packed: ${result.missing.join(', ')}`)
  if (result.missingTransitive.length > 0) {
    const shown = result.missingTransitive.slice(0, 8).join(', ')
    console.log(`  · ${result.missingTransitive.length} transitive package(s) not packed (usually pruned on purpose): ${shown}${result.missingTransitive.length > 8 ? ', …' : ''}`)
  }
  if (result.ok) console.log('  ✓ contains only what the main process loads')
  return result.ok ? 0 : 1
}

try {
  process.exitCode = run(process.argv.slice(2))
} catch (error) {
  console.error(`electron-slim: ${error.message}`)
  process.exitCode = 2
}
