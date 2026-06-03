/**
 * Dispatch-unification spike — experiment arm (Arm A).
 *
 * This standalone entrypoint attempts the "option (a)" path: get
 * `@oclif/core`'s `execute()` to dispatch a command WITHOUT an on-disk
 * `commands/` tree, the way it would have to inside a `bun build --compile`
 * single-file binary.
 *
 * It is compiled to its OWN outfile (never the shipped `dist/lando`) and run
 * from a directory OUTSIDE the source tree so OCLIF's `Config.load()` →
 * `findRoot()` cannot walk up to the repo `package.json`. That faithfully
 * reproduces a deployed `$bunfs` binary, where:
 *   1. `findRoot()` cannot locate the package root, so `Config` mis-roots /
 *      throws, and
 *   2. even with a static manifest, command dispatch still does a runtime
 *      `import()` of a computed absolute path that the bundler never embedded,
 *      producing a `ModuleLoadError`.
 *
 * The probe does NOT try to succeed. Its observable failure (non-zero exit +
 * the captured error text on stderr) IS the spike evidence. It prints a
 * machine-readable verdict line prefixed with `PROBE_VERDICT=` so the test can
 * assert the outcome deterministically regardless of how OCLIF surfaces the
 * failure (thrown error vs `process.exit`).
 */
import { execute } from "@oclif/core";

const argv = process.argv.slice(2);
const commandArgs = argv.length > 0 ? argv : ["meta:version"];

const emitVerdict = (dispatched: boolean, detail: string): void => {
  // Single, greppable line. Truncated so a long stack never floods the test.
  process.stderr.write(`PROBE_VERDICT=${JSON.stringify({ dispatched, detail: detail.slice(0, 500) })}\n`);
};

try {
  // `dir` is the binary's own location on real disk. Outside the repo, walking
  // up from here cannot reach the source `commands/` tree.
  await execute({ dir: process.execPath, args: commandArgs });
  // If we get here, OCLIF dispatched without on-disk discovery — option (a) is
  // reachable via the naive path and the spike conclusion must be revisited.
  emitVerdict(true, "execute() returned without throwing");
} catch (error) {
  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  emitVerdict(false, `${name}: ${message}`);
  process.exitCode = 1;
}
