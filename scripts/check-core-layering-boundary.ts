import { resolve } from "node:path";

import { runGate } from "./boundary/format.ts";

const repoRoot = resolve(import.meta.dirname, "..");

if (import.meta.main) {
  await runGate("core-layering", repoRoot);
}
