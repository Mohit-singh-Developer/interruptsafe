import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Runs every offline verification suite.
 *
 * These need no credentials, no network and no running server, so anyone can
 * reproduce the correctness claims made in docs/RIME_EVIDENCE.md with a single
 * command:
 *
 *   npm run verify
 *
 * Each suite is a separate process because each one calls `process.exit` with
 * its own status; importing them in-process would end the run at the first
 * suite. Exit status is non-zero if any suite fails, so this is usable in CI.
 */

const here = dirname(fileURLToPath(import.meta.url));
const checksDir = join(here, "checks");

const suites = readdirSync(checksDir)
  .filter((name) => name.endsWith(".ts"))
  .sort();

const failures: string[] = [];

for (const suite of suites) {
  console.log(`\n${"=".repeat(60)}\n${suite}\n${"=".repeat(60)}`);

  const result = spawnSync("npx", ["tsx", join(checksDir, suite)], {
    stdio: "inherit",
    shell: true,
  });

  if (result.status !== 0) failures.push(suite);
}

console.log(`\n${"=".repeat(60)}`);
if (failures.length === 0) {
  console.log(`ALL ${suites.length} SUITES PASSED`);
} else {
  console.log(`${failures.length} of ${suites.length} SUITES FAILED:`);
  for (const suite of failures) console.log(`  - ${suite}`);
}
console.log("=".repeat(60));

process.exit(failures.length === 0 ? 0 : 1);
