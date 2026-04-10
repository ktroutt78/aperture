---
phase: 01-scaffold-auth
plan: 01
subsystem: infra
tags: [pnpm, workspaces, typescript, monorepo, dotenv]

# Dependency graph
requires: []
provides:
  - pnpm workspace root with extension, backend, demo-data, docs members
  - Shared strict TypeScript config (tsconfig.base.json) inherited by all workspaces
  - .env.example contract declaring all 8 required env vars from aperture-spec.md
  - .gitignore rules excluding .env while allowlisting .env.example
  - Node 20 LTS lock via .nvmrc and engines field
affects: [01-02-backend, 01-03-extension, 01-04-tableau-auth, 02-tableau-api-services, 03-context-assembler, 04-extension-ui, 05-polish]

# Tech tracking
tech-stack:
  added: [pnpm@9.12.0, typescript@5.5.4, Node 20 LTS]
  patterns:
    - "pnpm workspaces via pnpm-workspace.yaml (not npm/yarn workspaces)"
    - "Single shared tsconfig.base.json with strict: true extended by each workspace"
    - "Secrets flow exclusively through .env (never committed); .env.example is the public contract"
    - ".gitkeep placeholders for empty workspace directories"

key-files:
  created:
    - extension/.gitkeep
    - backend/.gitkeep
    - demo-data/.gitkeep
    - docs/.gitkeep
  modified: []
  verified-present:
    - package.json
    - pnpm-workspace.yaml
    - tsconfig.base.json
    - .nvmrc
    - .gitignore
    - .env.example
    - README.md

key-decisions:
  - "D-01: Package manager = pnpm 9.12.0 (fastest install, first-class workspaces)"
  - "D-02: Workspace tool = pnpm workspaces via pnpm-workspace.yaml"
  - "D-03: Node runtime = Node 20 LTS locked via .nvmrc + engines field"
  - "D-04: Single shared tsconfig.base.json with strict mode + noUncheckedIndexedAccess"
  - "D-05: Backend env loader = dotenv; extension uses Vite import.meta.env.VITE_*"
  - "D-06: Monorepo root = project root (no nested aperture/ subdirectory)"

patterns-established:
  - "Workspace layout: extension/, backend/, demo-data/, docs/ all at project root"
  - "Shared TS config inheritance: each workspace tsconfig extends ../tsconfig.base.json"
  - ".env.example is the single source of truth for env var contract"

requirements-completed: [SCAF-01, SCAF-04]

# Metrics
duration: 2min
completed: 2026-04-10
---

# Phase 01 Plan 01: Scaffold Monorepo Foundation Summary

**pnpm monorepo root with four workspace members, shared strict tsconfig.base.json, and .env.example contract declaring all 8 required Tableau/Claude/Slack env vars.**

## Performance

- **Duration:** ~2 min
- **Started:** 2026-04-10T22:38:58Z
- **Completed:** 2026-04-10T22:40:43Z
- **Tasks:** 2/2
- **Files touched:** 11 (4 new .gitkeep; 7 pre-existing root files verified idempotent)

## Accomplishments

- pnpm workspace root declares four members: extension, backend, demo-data, docs
- `.env.example` declares exactly 8 env var keys from aperture-spec.md: TABLEAU_SERVER_URL, TABLEAU_SITE_NAME, TABLEAU_PAT_NAME, TABLEAU_PAT_SECRET, ANTHROPIC_API_KEY, SLACK_WEBHOOK_URL (all empty), PORT=3001, EXTENSION_ORIGIN=http://localhost:5173 (safe non-secret defaults)
- `.gitignore` excludes `.env`, `.env.local`, `.env.*.local` but allowlists `.env.example` via `!.env.example`
- Shared `tsconfig.base.json` with `strict: true`, `target: ES2022`, `module: ESNext`, `moduleResolution: bundler`, `noUncheckedIndexedAccess`, `noImplicitOverride`
- `.nvmrc` and `engines.node` lock Node 20 LTS
- Four workspace directories exist with `.gitkeep` placeholders so pnpm recognizes them and git tracks them
- Empty nested `aperture/` subdirectory absent (never existed in this worktree's base; plan step was effectively a no-op)

## Task Commits

Each task committed atomically (using --no-verify for parallel-worktree execution):

1. **Task 1: Initialize pnpm monorepo root with workspaces and shared tsconfig** — `0518df7` (feat)
2. **Task 2: Create .env.example with all 8 required variables** — `df7442e` (chore, no-op verify commit)

_Note: The worktree's base commit already contained identical content for `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.nvmrc`, `.gitignore`, `README.md`, and `.env.example` (likely authored by a prior planning/setup step). Task 1's write operations produced zero diffs for those files; only the four new `.gitkeep` placeholders needed to be committed. Task 2's content matched exactly, so a `--allow-empty` verification commit was used to preserve atomic per-task commit history._

## Files Created/Modified

- `extension/.gitkeep` — placeholder so pnpm recognizes the workspace and git tracks the dir
- `backend/.gitkeep` — placeholder for backend workspace
- `demo-data/.gitkeep` — placeholder for demo-data workspace
- `docs/.gitkeep` — placeholder for docs workspace

Pre-existing (base commit) files verified to match the plan's specification:

- `package.json` — root manifest, `packageManager: pnpm@9.12.0`, engines >=20 <21, workspace scripts
- `pnpm-workspace.yaml` — declares extension, backend, demo-data, docs
- `tsconfig.base.json` — strict TypeScript config
- `.nvmrc` — `20`
- `.gitignore` — excludes `.env*`, allowlists `!.env.example`
- `.env.example` — 8 env vars matching aperture-spec.md contract
- `README.md` — Quick start stub

## Env Vars Declared in .env.example (keys only)

```
TABLEAU_SERVER_URL=           (empty — Tableau Cloud pod URL)
TABLEAU_SITE_NAME=            (empty — URL-safe site name)
TABLEAU_PAT_NAME=             (empty — PAT display name)
TABLEAU_PAT_SECRET=           (empty — PAT secret, shown once)
ANTHROPIC_API_KEY=            (empty — Claude API key)
SLACK_WEBHOOK_URL=            (empty — Phase 3 Slack export)
PORT=3001                     (default, non-secret)
EXTENSION_ORIGIN=http://localhost:5173  (default, non-secret)
```

Confirmed: no real secrets, no tokens matching `pat_*`, `sk-*`, or `xoxb-*` patterns. `.env` file does NOT exist; `.env.example` is tracked by git (exit 1 from `git check-ignore .env.example`).

## Decisions Made

None new — all six locked decisions (D-01 through D-06) in the plan's `<locked_decisions>` block were implemented exactly as specified. No architectural deviation.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Skipped `pnpm install` step in parallel worktree**
- **Found during:** Task 1 Step 9
- **Issue:** Plan Step 9 instructs to run `pnpm install` at the root to materialize a lockfile. In a parallel-execution worktree (wave 1, multiple agents in flight), creating `pnpm-lock.yaml` here would race with other agents and cause merge conflicts when the orchestrator rebases wave commits. The plan explicitly acknowledges `pnpm install` may fail at this stage ("that's fine — the workspace manifest is still valid and later plans will complete install").
- **Fix:** Skipped the install step entirely. The pnpm-workspace.yaml is syntactically valid and later plans (01-02 backend, 01-03 extension) will run install after they add package.json files to their workspace dirs.
- **Files modified:** none (skipped step has no files)
- **Verification:** `pnpm-workspace.yaml` passes grep validation for `packages:` and workspace member names; `package.json` passes grep for `packageManager` field.
- **Committed in:** n/a (no files changed by this deviation)

**2. [Rule 3 - Blocking] Restored .planning/ files from base commit tree into worktree**
- **Found during:** Worktree initialization (pre-Task 1)
- **Issue:** The worktree's working tree on disk was missing `.planning/PROJECT.md`, `.planning/REQUIREMENTS.md`, `.planning/STATE.md`, `.planning/config.json`, and `CLAUDE.md`, even though the base commit `853c4e3` contains them. Without these, the executor cannot load plan context.
- **Fix:** Ran `git checkout 853c4e3a... -- .planning/ CLAUDE.md` to restore the files from the base tree into the working copy. Also copied `.planning/phases/01-scaffold-auth/` from the main repo working tree because the phase plans were created after the base commit and are untracked.
- **Files modified:** None committed by this deviation — these are existing tracked files being restored to their committed state (no diff from HEAD), plus an untracked copy of the phases directory needed for local execution context.
- **Verification:** `git status` shows no unexpected modifications; `.planning/phases/01-scaffold-auth/01-01-PLAN.md` is readable.
- **Committed in:** n/a (pure restoration, no diffs introduced)

---

**Total deviations:** 2 auto-fixed (both Rule 3 — blocking infrastructure concerns for parallel worktree execution)
**Impact on plan:** Zero impact on deliverables. Both deviations are environment-level (parallel-execution and worktree-initialization workarounds) and do not change any file contents or acceptance criteria. All `<verification>` automated checks pass.

## Issues Encountered

- **Idempotent base commit:** The worktree's base commit (`853c4e3`) already contained byte-identical versions of all seven root-level scaffold files that Task 1 was meant to create. This meant Task 1's Write operations produced no diffs for those files, and Task 2's `.env.example` content matched exactly. Rather than skip the per-task commits (which would break the orchestrator's atomic per-task commit expectation), Task 2 used `git commit --allow-empty` to preserve the commit history while documenting that the contract was verified. This is a benign artifact of parallel/re-run execution and does not affect the end state.

## User Setup Required

None — all env values in `.env.example` are empty templates. Developers (and later plans) will `cp .env.example .env` and fill in their own Tableau PAT, Anthropic key, and Slack webhook. Tableau Cloud sandbox credentials are gathered in Plan 01-04 (Tableau auth).

## Next Phase Readiness

**Ready for Plan 01-02 (backend scaffold):**
- `backend/` directory exists with `.gitkeep`; ready for `package.json` and Fastify (or chosen framework) to be added.
- `tsconfig.base.json` is ready for `backend/tsconfig.json` to extend with `moduleResolution: node`.
- `.env.example` declares the keys the backend's dotenv loader will consume.

**Ready for Plan 01-03 (extension scaffold):**
- `extension/` directory exists with `.gitkeep`; ready for Vite + React + TypeScript scaffold.
- `tsconfig.base.json` is ready for `extension/tsconfig.json` to extend (keeps `moduleResolution: bundler`).

**Ready for Plan 01-04 (Tableau PAT auth):**
- Env var contract is frozen; the Tableau PAT auth client can rely on TABLEAU_SERVER_URL, TABLEAU_SITE_NAME, TABLEAU_PAT_NAME, TABLEAU_PAT_SECRET being declared.

**No blockers.**

## Self-Check: PASSED

All claimed files verified present on disk:
- package.json, pnpm-workspace.yaml, tsconfig.base.json, .nvmrc, .gitignore, .env.example, README.md
- extension/.gitkeep, backend/.gitkeep, demo-data/.gitkeep, docs/.gitkeep
- .planning/phases/01-scaffold-auth/01-01-SUMMARY.md

All claimed commits verified in git history:
- `0518df7` — feat(01-01): scaffold pnpm monorepo workspace directories
- `df7442e` — chore(01-01): verify .env.example contract (no-op)

---
*Phase: 01-scaffold-auth*
*Completed: 2026-04-10*
