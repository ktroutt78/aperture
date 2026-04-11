/**
 * Phase 2 verification harness (TAPI-11).
 *
 * Runs the three Tableau service smoke scripts sequentially against the
 * sandbox (or in cold-boot mode when .env is empty) plus the offline
 * pulseService.empty.test.ts which guards TAPI-10 graceful-degradation.
 *
 * Exit 0 only if every child exits 0.
 *
 * Run with: pnpm --filter @aperture/backend smoke:phase2
 *
 * Any extra CLI args after the script name are forwarded verbatim to every
 * child (so `... smoke:phase2 -- --datasource <luid>` flows through to each
 * of metadataService.smoke, vizqlService.smoke, and pulseService.smoke).
 * Children that don't recognize a flag ignore it and cold-boot cleanly.
 *
 * Safety:
 *   - spawn() is invoked WITHOUT `shell: true` — no shell interpolation of
 *     forwarded args (mitigates T-02-05-02).
 *   - stdio: 'inherit' streams child output directly — this harness never
 *     buffers and never logs env, tokens, or PII (T-02-05-03 is owned by
 *     the child scripts per their own acceptance criteria).
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface Step {
  readonly label: string;
  readonly script: string; // path relative to this file's directory
  readonly requirement: string;
}

const STEPS: readonly Step[] = [
  {
    label: 'Metadata API',
    script: './metadataService.smoke.ts',
    requirement: 'TAPI-01/02',
  },
  {
    label: 'VizQL Data Svc',
    script: './vizqlService.smoke.ts',
    requirement: 'TAPI-03/04/05/06',
  },
  {
    label: 'Pulse REST',
    script: './pulseService.smoke.ts',
    requirement: 'TAPI-07/08/09',
  },
  {
    label: 'Pulse empty (offline)',
    script: './pulseService.empty.test.ts',
    requirement: 'TAPI-10',
  },
];

function runStep(step: Step): Promise<number> {
  return new Promise((resolvePromise) => {
    const fullPath = resolve(__dirname, step.script);
    console.log(`\n================================================================`);
    console.log(`[phase2] Running ${step.label} (${step.requirement})`);
    console.log(`[phase2] Script: ${step.script}`);
    console.log(`================================================================`);
    // Forward argv after the harness's own args so callers can pass
    // --datasource / --workbook / --field flags to every child.
    const childArgs = process.argv.slice(2);
    const child = spawn('npx', ['tsx', fullPath, ...childArgs], {
      stdio: 'inherit',
      env: process.env,
    });
    child.on('exit', (code) => resolvePromise(code ?? 1));
    child.on('error', (err) => {
      console.error(`[phase2] Failed to spawn ${step.label}:`, err);
      resolvePromise(1);
    });
  });
}

async function main(): Promise<void> {
  const results: Array<{ step: Step; code: number }> = [];
  for (const step of STEPS) {
    const code = await runStep(step);
    results.push({ step, code });
    if (code !== 0) {
      // Continue running remaining steps so the user sees the full picture,
      // but mark overall as failed.
      console.log(`[phase2] ${step.label} exited with code ${code}`);
    }
  }

  console.log(`\n================================================================`);
  console.log(`[phase2] SUMMARY`);
  console.log(`================================================================`);
  let allPass = true;
  for (const { step, code } of results) {
    const status = code === 0 ? 'PASS' : 'FAIL';
    if (code !== 0) allPass = false;
    console.log(`[phase2]   ${status}  ${step.label.padEnd(26)} (${step.requirement})`);
  }
  console.log(`================================================================`);
  if (allPass) {
    console.log(`[phase2] ALL GREEN — Phase 2 TAPI-01..TAPI-11 verified (TAPI-11)`);
    process.exit(0);
  } else {
    console.error(`[phase2] FAILED — one or more services did not exit 0`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[phase2] Fatal harness error:', err);
  process.exit(1);
});
