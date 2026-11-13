<p align="center">
  <img src="logo.svg" width="96" height="96" alt="electron-slim-kit logo">
</p>

# electron-slim-kit

Stop shipping packages your Electron app never loads.

An Electron installer includes every package under `dependencies`. If your renderer is bundled
(vite, esbuild, webpack…), its packages are already inside the bundle — listing them under
`dependencies` ships them a second time, unbundled, and nothing ever reads that copy.

This kit finds them, proposes the smallest fix, and checks the packed app afterwards.
Zero dependencies. It reads files; it never runs your app's code.

Real results from the projects it was built on:

| App | Before | What it found |
|---|---|---|
| A desktop client whose main process is one esbuild bundle | `app.asar` 28 MB, 183 packages | Nothing was loaded from `node_modules`. After the fix: 0.5 MB, 0 packages |
| A video app with an unbundled main process | 5 renderer packages under `dependencies` | They pulled 67 packages (75.5 MB) into the installer that nothing loads |
| A small viewer where vite and the packager both wrote to `dist/` | `app.asar` 268 MB | Every build packed the previous build — the whole runtime — into itself. After: 0.2 MB |

## Use it

```bash
# 1. What ships for nothing?
npx github:Jeffrey0117/electron-slim-kit audit .

# 2. What would fix it? (prints the change; add --write to apply)
npx github:Jeffrey0117/electron-slim-kit fix .
npx github:Jeffrey0117/electron-slim-kit fix . --write

# 3. Pack the app the way you normally do, then check the result
npx electron-builder --dir
npx github:Jeffrey0117/electron-slim-kit verify .
```

`audit` output:

```
revid 0.8.0
  entry: electron\main.cjs  (+ preload: electron\preload.cjs) — 27 files followed
  loaded by the main process (4): electron-updater, family-kit, ffmpeg-static, opencc-js
      → 36 packages to ship, 84.6 MB
  shipped but never loaded (5): @react-pdf/renderer, hls.js, plyr, react, react-dom
      → 9 packages only they need, 14.7 MB
```

`verify` exits with code 1 when something shipped for nothing, or when a package the main
process loads is missing from the archive — so it can gate a release.

## How it decides

It starts at the main entry (`build.extraMetadata.main`, else `main` in package.json) and follows
`require` / `import` through your own files. Preload scripts are found from the paths that mention
them. Every package reached that way is **needed**; every other entry in `dependencies` is not.

Then it picks one of two fixes:

| Situation | Fix |
|---|---|
| The main process loads **no** package (it is a self-contained bundle) | Add `"!node_modules/**/*"` to `build.files` and set `build.npmRebuild: false` |
| The main process loads **some** packages | Move the others from `dependencies` to `devDependencies` — still bundled, no longer shipped |
| The packager's output folder is matched by `build.files` (both vite and electron-builder writing to `dist/`) | Set `build.directories.output` to a folder nothing packs. Then delete the old output folder and git-ignore the new one |

The last one is independent of the other two and is applied on top of either. `verify` also
fails when it finds a packed app (`win-unpacked/`, a nested `app.asar`…) inside the archive.

The audit reads **what actually ships**. If your main entry is build output, build first; the kit
refuses to guess from sources, because whether a bundler inlined a package is exactly the question.

## Options

- `--entry <file>` — an extra file that is started by path rather than imported (a worker, a
  utility process). Repeatable.
- `--asar <path>` — check a specific `app.asar` instead of the newest one under `release/`,
  `dist/`, `out/`.
- `--json` — machine-readable output for `audit` and `verify`.

## As a library

```js
const { auditProject, planFix, applyFix, verifyPackage, findPackedAsar } = require('electron-slim-kit')

const audit = auditProject('/path/to/app', { entries: ['electron/worker.cjs'] })
// audit.neededByMain, audit.notLoadedByMain, audit.dropBytes, audit.dynamicLoads …

const plan = planFix(audit) // { kind: 'move-to-dev' | 'exclude-all' | 'none', changes, apply }
applyFix('/path/to/app', plan) // rewrites package.json, keeping indentation and line endings

const result = verifyPackage(findPackedAsar('/path/to/app'), audit)
// result.ok, result.unexpected, result.missing, result.missingTransitive
```

`plan.apply(pkg)` is pure: it returns a new object and leaves its input untouched.

## What it cannot see

- **Computed loads** — `require(name)`, ``require(`./x/${id}`)``. The audit counts them
  (`dynamicLoads`) and warns; check those by hand.
- **Packages loaded only through a path string** other than a preload (for example
  `fork('node_modules/x/cli.js')`). Pass the file with `--entry`, or keep the package.
- **Nested `node_modules`** are attributed to the top-level package that contains them.
- **A stale `node_modules`**: if package.json lists a package that was never installed, the
  packager silently leaves it out. `audit` warns (`notInstalled`) and `verify` fails; run your
  package manager's install before packing.
- `fix --write` re-serialises package.json: indentation, line endings and the final newline are
  kept, but objects written on one line are expanded.
- It is a static reading. After a fix, **pack and launch the app once** — `verify` proves the
  archive is right, not that every code path runs.

Works with electron-builder. Under Electron Forge with a bundler plugin, `node_modules` is not
shipped in the first place; use `verify` to confirm.

## Tests

```bash
npm test
```

MIT
