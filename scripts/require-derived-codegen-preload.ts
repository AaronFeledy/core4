/**
 * Runs before other test-preload imports so missing codegen fails closed
 * with an actionable message instead of a cryptic resolve error.
 */
import { resolve } from "node:path";

import { assertDerivedCodegen } from "./require-derived-codegen.ts";

const repoRoot = resolve(import.meta.dir, "..");
try {
  assertDerivedCodegen(repoRoot);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
