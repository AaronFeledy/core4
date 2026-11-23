#!/usr/bin/env bun
import { changedXdebugPins, isStableXdebug, readXdebugPins } from "./xdebug-pins.ts";

if (import.meta.main) {
  const [baselinePath, candidatePath, mode, ...extra] = process.argv.slice(2);
  if (
    !baselinePath ||
    !candidatePath ||
    (mode !== undefined && mode !== "--changed-versions") ||
    extra.length > 0
  ) {
    throw new TypeError(
      "Usage: bun run scripts/report-xdebug-update.ts <baseline-pins> <candidate-pins> [--changed-versions]",
    );
  }
  const changes = changedXdebugPins(await readXdebugPins(baselinePath), await readXdebugPins(candidatePath));
  if (mode === "--changed-versions") {
    process.stdout.write(`${changes.map(({ php }) => php).join("\n")}\n`);
  } else {
    const lines = ["# Xdebug pin update", ""];
    for (const { php, before, after } of changes) {
      lines.push(
        `- PHP ${php}: ${before?.version ?? "not pinned"} -> ${after.version} (${isStableXdebug(after.version) ? "stable" : "pre-release"})`,
        `  - Supported PHP: ${after.phpMin} to ${after.phpMax}`,
        `  - Tarball: ${after.url}`,
        `  - SHA-256: \`${after.sha256}\``,
        `  - Build check passed on \`php:${php}-cli-bookworm\`.`,
      );
    }
    if (changes.length === 0) lines.push("No PHP pins changed.");
    process.stdout.write(`${lines.join("\n")}\n`);
  }
}
