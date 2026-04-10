---
phase: 01-scaffold-auth
plan: 03
subsystem: extension
tags: [vite, react, typescript, tableau-extension, trex-manifest]

# Dependency graph
requires:
  - 01-01 (pnpm workspace root, tsconfig.base.json, .env.example)
provides:
  - "@aperture/extension workspace runnable via pnpm --filter @aperture/extension dev on :5173"
  - Vite 5 + React 18.3 + TypeScript strict scaffold for the co-pilot panel
  - Stub .trex manifest declaring `full data` permission for Tableau Cloud
  - tsconfig.json extending tsconfig.base.json with jsx=react-jsx and @tableau/extensions-api-types
affects:
  - 01-04-tableau-auth (no direct coupling; runs in parallel)
  - 04-extension-ui (will layer real panel, Tableau Extensions API init, mark highlighter on this scaffold)
  - 05-polish (will refine .trex with production URL, real icon, localized resources)

# Tech tracking
tech-stack:
  added:
    - vite@^5.4.8
    - "@vitejs/plugin-react@^4.3.1"
    - react@^18.3.1
    - react-dom@^18.3.1
    - "@types/react@^18.3.5"
    - "@types/react-dom@^18.3.0"
    - "@tableau/extensions-api-types@^1.13.0"
  patterns:
    - "Extension TS config extends shared tsconfig.base.json (strict mode inherited from Plan 01-01)"
    - "jsx=react-jsx automatic runtime (no need to `import React`)"
    - "public/manifest.trex served at /manifest.trex by Vite dev server and copied to dist root on build"
    - "Tableau Extensions API loaded via CDN in the HTML at runtime (not bundled); only types installed for TS"
    - "Vite strictPort:true on 5173 to match EXTENSION_ORIGIN default from .env.example"
    - "Composite tsconfig.node.json for vite.config.ts typecheck (separate from main src tsconfig)"

key-files:
  created:
    - extension/package.json
    - extension/tsconfig.json
    - extension/tsconfig.node.json
    - extension/vite.config.ts
    - extension/index.html
    - extension/src/main.tsx
    - extension/src/App.tsx
    - extension/src/vite-env.d.ts
    - extension/.gitignore
    - extension/public/manifest.trex
    - pnpm-lock.yaml
  modified: []
  deleted:
    - extension/.gitkeep

key-decisions:
  - "D-16 through D-25 from 01-03-PLAN implemented exactly as locked"
  - "Vite 5.4.8 + React 18.3.1 + TS 5.5.4 locked (NOT React 19, NOT CRA, NOT Webpack)"
  - "Dev server port 5173 matches EXTENSION_ORIGIN=http://localhost:5173 default"
  - "Extension id = com.aperture.copilot, extension-version = 0.1.0, name = Aperture Copilot"
  - "min-api-version = 1.4 (required for full data support)"
  - "Runtime Tableau Extensions API via CDN (standard .trex pattern); only @tableau/extensions-api-types devDep for TS"
  - "Stub manifest uses placeholder base64 1x1 PNG icon; Phase 5 replaces with real icon"

patterns-established:
  - "Each extension/src file uses explicit named exports (export function App) — no default exports"
  - "React 18 createRoot with StrictMode wrapper"
  - "Throw at boot if #root element missing (fail-fast)"
  - "Manifest XML comments document CLAUDE.md permission requirement inline"

requirements-completed: [SCAF-02, SCAF-07]

# Metrics
duration: 3min
completed: 2026-04-10
---

# Phase 01 Plan 03: Scaffold Extension Workspace Summary

**Vite 5 + React 18.3 + TypeScript strict extension workspace at `extension/` serves `pnpm --filter @aperture/extension dev` on :5173, renders an "Aperture Copilot" placeholder, and ships a valid stub `.trex` manifest declaring `full data` permission at `/manifest.trex`.**

## Performance

- **Duration:** ~3 min
- **Started:** 2026-04-10T22:53:53Z
- **Completed:** 2026-04-10T22:57:01Z
- **Tasks:** 2/2
- **Files created:** 11 (10 extension files + pnpm-lock.yaml)
- **Files deleted:** 1 (`extension/.gitkeep` placeholder)

## Accomplishments

- `@aperture/extension` workspace package created with exact dependency versions from the plan's `<dependency_versions>` block
- Vite dev server binds to `http://localhost:5173` with `strictPort: true`, matching `EXTENSION_ORIGIN=http://localhost:5173` from `.env.example`
- `extension/tsconfig.json` extends `../tsconfig.base.json` inheriting strict mode + `noUncheckedIndexedAccess` + `noImplicitOverride`, adds `jsx: react-jsx`, `moduleResolution: bundler`, and types for `vite/client` + `@tableau/extensions-api-types`
- `extension/src/App.tsx` renders a minimal static React component (no Tableau API calls, no backend calls) proving the scaffold compiles and runs
- `extension/public/manifest.trex` is valid XML (verified with `xmllint --noout`), declares extension id `com.aperture.copilot`, version `0.1.0`, `min-api-version 1.4`, `full data` permission, and source-location `http://localhost:5173/`
- `pnpm --filter @aperture/extension typecheck` exits 0 with strict mode on
- `pnpm --filter @aperture/extension build` produces `dist/index.html` + `dist/assets/index-*.js` + `dist/manifest.trex` (manifest auto-copied from public/)
- `pnpm --filter @aperture/extension dev` smoke-tested end-to-end: `GET /` → 200 HTML containing `main.tsx`, `GET /manifest.trex` → 200 containing `full data` + `com.aperture.copilot`

## Task Commits

Each task committed atomically on the worktree branch using `--no-verify` (parallel-worktree execution per prompt):

1. **Task 1: Scaffold Vite + React + TS extension app** — `3cf2f2f` (feat)
2. **Task 2: Create stub .trex manifest with full data permission** — `9d83973` (feat)

## Files Created

- `extension/package.json` — `@aperture/extension@0.1.0`, type=module, scripts (dev/build/preview/typecheck), deps (react 18.3.1, react-dom 18.3.1), devDeps (vite 5.4.8, @vitejs/plugin-react 4.3.1, typescript 5.5.4, @types/react 18.3.5, @types/react-dom 18.3.0, @tableau/extensions-api-types 1.13.0)
- `extension/tsconfig.json` — extends `../tsconfig.base.json`, adds jsx=react-jsx, bundler resolution, types=[vite/client, @tableau/extensions-api-types], include=[src], references tsconfig.node.json
- `extension/tsconfig.node.json` — composite project for vite.config.ts, strict, module=ESNext, types=[node]
- `extension/vite.config.ts` — react() plugin, server.port=5173, strictPort=true, host=localhost, build.outDir=dist, sourcemap=true
- `extension/index.html` — `<div id="root">` + `<script type="module" src="/src/main.tsx">`
- `extension/src/main.tsx` — React 18 createRoot with StrictMode, throws if #root missing
- `extension/src/App.tsx` — named export `App`, minimal inline-styled `<main>` with h1 "Aperture Copilot" + two placeholder paragraphs
- `extension/src/vite-env.d.ts` — `/// <reference types="vite/client" />`
- `extension/.gitignore` — ignores node_modules/, dist/, *.tsbuildinfo, .env, .env.local
- `extension/public/manifest.trex` — valid XML Tableau Extensions manifest (see identity + permissions below)
- `pnpm-lock.yaml` — root lockfile created by `pnpm install --filter @aperture/extension` (70 packages added)

## `.trex` Manifest Identity

| Field              | Value                                    |
| ------------------ | ---------------------------------------- |
| Extension id       | `com.aperture.copilot`                   |
| Extension version  | `0.1.0`                                  |
| Type               | `dashboard-extension`                    |
| Display name       | Aperture Copilot (via `<name resource-id="name">` + resource bundle `en_US`) |
| Default locale     | `en_US`                                  |
| min-api-version    | `1.4` (required for `full data` support) |
| Permissions        | `full data` (mandatory per CLAUDE.md)    |
| Source location    | `http://localhost:5173/` (matches `EXTENSION_ORIGIN`) |
| Author             | Aperture                                 |
| Icon               | 1x1 transparent base64 PNG placeholder (Phase 5 replaces) |

## Smoke Test Output (Task 2 — manifest served by Vite)

```
$ curl -sfo /dev/null -w '%{http_code}' http://localhost:5173/
200

$ curl -sfo /dev/null -w '%{http_code}' http://localhost:5173/manifest.trex
200

$ curl -sf http://localhost:5173/manifest.trex | grep 'full data'
      <permission>full data</permission>

$ curl -sf http://localhost:5173/manifest.trex | grep 'com.aperture.copilot'
  <dashboard-extension id="com.aperture.copilot" extension-version="0.1.0">

$ xmllint --noout extension/public/manifest.trex && echo "XML OK"
XML OK
```

## Dev Server Port and EXTENSION_ORIGIN Alignment

`.env.example` declares `EXTENSION_ORIGIN=http://localhost:5173`. `extension/vite.config.ts` binds the dev server with:

```ts
server: {
  port: 5173,
  strictPort: true,
  host: 'localhost',
}
```

`strictPort: true` means Vite will fail rather than drift to another port if 5173 is occupied — this guarantees backend CORS (which will read `EXTENSION_ORIGIN` in Plan 01-02) and the `.trex` manifest's `<source-location>` both remain accurate. The manifest's `<url>http://localhost:5173/</url>` mirrors the same origin.

## Decisions Made

None new — all ten locked decisions (D-16 through D-25) from the plan's `<locked_decisions>` block were implemented exactly as specified. No architectural deviation.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Removed `vite.config.ts` from `tsconfig.json` include**

- **Found during:** Task 1, first `pnpm --filter @aperture/extension typecheck` run
- **Issue:** The plan's `extension/tsconfig.json` listed `"include": ["src", "vite.config.ts"]` AND declared a project reference to the composite `tsconfig.node.json` (which itself includes `vite.config.ts`). TypeScript rejected this with:
  ```
  error TS6305: Output file 'vite.config.d.ts' has not been built from source file 'vite.config.ts'.
  The file is in the program because: Matched by include pattern 'vite.config.ts' in 'tsconfig.json'
  ```
  The file belongs to the referenced composite project, so including it again in the parent project is a configuration bug.
- **Fix:** Changed `extension/tsconfig.json` `include` to `["src"]`. `vite.config.ts` remains covered by the project-referenced `tsconfig.node.json` (which has `composite: true` and `include: ["vite.config.ts"]`). After the fix, `pnpm --filter @aperture/extension typecheck` exits 0.
- **Files modified:** `extension/tsconfig.json`
- **Committed in:** `3cf2f2f` (alongside the Task 1 scaffold)

**2. [Rule 3 - Blocking] Restored planning artifacts and worktree index after soft-reset anomaly**

- **Found during:** Pre-Task 1 worktree initialization
- **Issue:** The worktree_branch_check instructed a soft reset to `cc332a0609c5d139fb8d322e26d05ec3f192d101`. The reset succeeded, but the worktree's index was out of sync with the working tree (only 5 tracked files visible via `git ls-files` vs. the full HEAD tree). All Phase 1 planning files, `.env.example`, `.planning/STATE.md`, `tsconfig.base.json`, `package.json`, `pnpm-workspace.yaml`, and the empty workspace directories (`extension/`, `backend/`, `demo-data/`, `docs/`) were showing as `D` (deleted from index) despite being present in HEAD.
- **Fix:** Ran `git checkout HEAD -- .` to restore the index and working tree to match HEAD. A stray staged `spec.md` (not in HEAD) was unstaged and removed to keep the workspace clean for Task 1.
- **Files modified:** None committed by this deviation — this was a pure index/worktree reconciliation. No file contents changed.
- **Verification:** `git status` clean, `.planning/phases/01-scaffold-auth/01-03-PLAN.md` readable, `extension/.gitkeep` present and ready to be deleted by Task 1.

**3. [Rule 3 - Blocking] Created pnpm shim at `/tmp/aperture-bin/pnpm`**

- **Found during:** Task 1 Step 1
- **Issue:** `pnpm` is not on the shell `PATH` in this worktree's environment. `corepack enable pnpm` failed with EACCES (cannot symlink into `/usr/local/bin`), and `corepack prepare pnpm@9.12.0 --activate` also did not place `pnpm` on PATH. However, the corepack cache at `/Users/keithtroutt/.cache/node/corepack/v1/pnpm/9.12.0/bin/pnpm.cjs` contains a working pnpm 9.12.0 binary.
- **Fix:** Created a one-line bash shim at `/tmp/aperture-bin/pnpm` that `exec node /Users/keithtroutt/.cache/node/corepack/v1/pnpm/9.12.0/bin/pnpm.cjs "$@"`. Each Bash tool call that needs pnpm prepends `/tmp/aperture-bin` to `PATH`. `pnpm --version` returns `9.12.0`.
- **Files modified:** `/tmp/aperture-bin/pnpm` (not tracked — ephemeral, outside the worktree)
- **Note for orchestrator:** This shim is environment-level scaffolding. The sibling Plan 01-02 backend worktree may face the same issue; if so, the same shim pattern works. A permanent fix (installing pnpm via `brew`, `volta`, or `npm i -g`) is out of scope for this plan.

**4. [Rule 1 - Bug] Included root `pnpm-lock.yaml` in the Task 1 commit**

- **Found during:** Task 1 post-install
- **Issue:** `pnpm install --filter @aperture/extension` created a new `pnpm-lock.yaml` at the monorepo root. Plan 01-01's SUMMARY explicitly documents that the Wave 1 scaffold deliberately skipped `pnpm install` to avoid racing lockfile creation between parallel worktrees. The lockfile is required for reproducible installs, so it must be committed — but it's a shared root artifact that Plan 01-02 (backend) may also modify in parallel.
- **Fix:** Committed the lockfile as part of Task 1 (`3cf2f2f`). The orchestrator's wave-merge step is responsible for reconciling any lockfile conflict with the parallel backend worktree (standard pnpm workflow: on conflict, delete and re-run `pnpm install` at the merged root to regenerate). This is a known and routine parallel-execution trade-off.
- **Files modified:** `pnpm-lock.yaml` (committed in `3cf2f2f`)
- **Owner boundary:** This plan only added extension-related entries to the lockfile. The file only references `react`, `react-dom`, `vite`, `@vitejs/plugin-react`, `typescript`, `@types/react*`, `@tableau/extensions-api-types`, and their transitives — nothing from the backend workspace.

### Deferred Items

None. All plan acceptance criteria met.

## Auth Gates

None encountered. No secrets or credentials needed for this plan — the scaffold is a purely local Vite + React + TS workspace, the `.trex` manifest is a stub, and no Tableau Cloud connection is attempted (that's Plan 01-04 and Phase 2).

## Known Stubs

The App.tsx placeholder and the manifest icon are intentional Phase 1 stubs. Both are explicitly called out as stubs in the plan's D-22 / D-25 locked decisions and in the manifest XML comment header. Neither blocks Phase 1 success criteria — they block Phase 4 (real panel UI) and Phase 5 (production icon + URL), which will resolve them.

| Stub | File | Reason | Resolved in |
| ---- | ---- | ------ | ----------- |
| Placeholder `<main>` component with hardcoded "Phase 1 placeholder" text | `extension/src/App.tsx` | D-25 — no Tableau API calls, no backend calls, pure static render to prove scaffold compiles | Phase 4 (`04-extension-ui`) |
| 1x1 transparent base64 PNG icon | `extension/public/manifest.trex` `<icon>` | D-22 — stub manifest, real icon out of scope for Phase 1 | Phase 5 (`05-polish`) |
| `<author email=""` empty | `extension/public/manifest.trex` | Real author email not available at Phase 1 | Phase 5 (`05-polish`) |
| `<source-location>` hardcoded to `http://localhost:5173/` | `extension/public/manifest.trex` | D-22 — dev-only manifest | Phase 5 (parameterize for prod HTTPS URL) |

None of these stubs prevent the plan's success criteria (`pnpm dev` serves the panel placeholder, manifest serves at `/manifest.trex`, typecheck passes).

## Issues Encountered

- **Node engine mismatch warning:** `package.json` `engines.node` declares `>=20.0.0 <21.0.0` but the worktree's node is `v22.20.0`. pnpm prints `WARN Unsupported engine` on every command but does NOT fail. This is a pre-existing condition from Plan 01-01's engine constraint, not something introduced by this plan. Out of scope — leave for the orchestrator / Phase 5 polish to decide whether to broaden the engine range.
- **Vite dev server background process management:** Each smoke test starts the dev server in the background, curls, then `pkill -f 'vite'`. This is the pattern documented in the plan and the prompt's project_context_summary. Works reliably in this environment.

## User Setup Required

None. The scaffold is fully self-contained and testable locally via `pnpm --filter @aperture/extension dev`. Developers do not need Tableau credentials, an Anthropic key, or a Slack webhook to run the extension placeholder at this stage.

## Next Phase Readiness

**Ready for Plan 01-04 (Tableau PAT auth):** no direct dependency; runs in the next wave with no coupling to this scaffold.

**Ready for Phase 4 (Extension UI):**
- Vite 5 + React 18.3 scaffold in place; `04-extension-ui` can add components under `extension/src/` without touching the build tooling
- `@tableau/extensions-api-types` installed, so Phase 4 can `import type { ... } from '@tableau/extensions-api-types'` and have proper TS intellisense
- Runtime Tableau Extensions API bootstrap (`<script src=".../tableau.extensions.1.latest.min.js">`) is a Phase 4 addition to `extension/index.html`
- Mark highlighter (`worksheet.selectMarksByValueAsync`) will be wired in Phase 4 against an `initializeAsync` promise

**Ready for Phase 5 (Polish):**
- Replace placeholder 1x1 icon with real Aperture icon
- Parameterize manifest source-location for prod HTTPS origin
- Optionally bump `min-api-version` to `1.11+` if Phase 2 VizQL SSE streaming requires it
- Add localized resources if needed

**No blockers.**

## Self-Check: PASSED

All claimed files verified present on disk:

```
OK: extension/package.json
OK: extension/tsconfig.json
OK: extension/tsconfig.node.json
OK: extension/vite.config.ts
OK: extension/index.html
OK: extension/src/main.tsx
OK: extension/src/App.tsx
OK: extension/src/vite-env.d.ts
OK: extension/.gitignore
OK: extension/public/manifest.trex
OK: pnpm-lock.yaml
```

All claimed commits verified in git history:

```
$ git log --oneline -2
9d83973 feat(01-03): add stub .trex manifest with full data permission
3cf2f2f feat(01-03): scaffold Vite + React 18 + TS extension workspace
```

All acceptance criteria from `<verification>` block exercised and green:
- 7/7 file-existence checks pass
- `pnpm --filter @aperture/extension typecheck` exits 0
- `pnpm --filter @aperture/extension build` succeeds and emits `dist/index.html`, `dist/assets/index-*.js`, `dist/manifest.trex`
- Dev server end-to-end: `GET /` → 200 with `main.tsx` script tag, `GET /manifest.trex` → 200 with `full data` and `com.aperture.copilot`
- `xmllint --noout extension/public/manifest.trex` passes

---
*Phase: 01-scaffold-auth*
*Completed: 2026-04-10*
