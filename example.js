'use strict'

// node example.js
//
// Builds a throwaway Electron project the way most of them look — an unbundled
// main process that needs one package, and a vite-bundled renderer whose
// packages are listed under `dependencies` — then audits it and shows the fix.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { auditProject, planFix } = require('./index.js')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-slim-example-'))
const write = (rel, content) => {
  const file = path.join(dir, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n')
}

write('package.json', {
  name: 'example-app',
  version: '1.0.0',
  main: 'electron/main.cjs',
  dependencies: { sharp: '^0.33.0', react: '^18.0.0', 'react-dom': '^18.0.0' },
  devDependencies: { 'electron-builder': '^26.0.0', vite: '^5.0.0' },
  build: { files: ['dist/**/*', 'electron/**/*'] },
})
write('electron/main.cjs', "const { app } = require('electron')\nconst sharp = require('sharp')\n")
for (const name of ['sharp', 'react', 'react-dom']) {
  write(`node_modules/${name}/package.json`, { name, version: '1.0.0' })
  write(`node_modules/${name}/index.js`, '// '.padEnd(200_000, 'x'))
}

const audit = auditProject(dir)
console.log('main process loads :', audit.neededByMain.join(', '))
console.log('shipped for nothing:', audit.notLoadedByMain.join(', '), `(${(audit.dropBytes / 1024).toFixed(0)} KB)`)

const plan = planFix(audit)
console.log(`\nplan: ${plan.kind}`)
for (const change of plan.changes) console.log('  •', change)

const before = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
const after = plan.apply(before)
console.log('\ndependencies after   :', Object.keys(after.dependencies).join(', '))
console.log('devDependencies after:', Object.keys(after.devDependencies).join(', '))

fs.rmSync(dir, { recursive: true, force: true })
