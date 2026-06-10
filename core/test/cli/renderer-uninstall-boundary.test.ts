import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Layer } from "effect";

import { renderUninstallResult, uninstall } from "../../src/cli/commands/uninstall.ts";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";
import { createBufferedRendererIO } from "../../src/cli/renderer/io.ts";

const isolatedOptions = (root: string) => ({
  userDataRoot: join(root, "data"),
  userCacheRoot: join(root, "cache"),
  execPath: join(root, "bin", "lando"),
});

beforeEach(() => {
  process.exitCode = undefined;
});

afterEach(() => {
  process.exitCode = undefined;
});

describe("uninstall output flows through the renderer seam", () => {
  test("a dry-run plan is written to the renderer stdout channel, never console", async () => {
    const root = mkdtempSync(join(tmpdir(), "lando-uninstall-renderer-"));
    try {
      const io = createBufferedRendererIO();
      await runWithRendererHandling(uninstall({ dryRun: true, ...isolatedOptions(root) }), {
        runtime: Layer.empty,
        rendererMode: "lando",
        io,
        render: renderUninstallResult,
        formatError: () => "unexpected uninstall failure",
      });

      expect(io.stdout()).toContain("uninstall plan (dry-run)");
      expect(io.stdout()).toContain("No changes were made.");
      expect(io.stderr()).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a refusal plan routes its result to stdout and sets exit code 1 via the seam", async () => {
    const root = mkdtempSync(join(tmpdir(), "lando-uninstall-renderer-"));
    try {
      const io = createBufferedRendererIO();
      let exitCode: number | undefined;
      await runWithRendererHandling(uninstall(isolatedOptions(root)), {
        runtime: Layer.empty,
        rendererMode: "lando",
        io,
        render: (result) =>
          renderUninstallResult(result, (code) => {
            exitCode = code;
          }),
        formatError: () => "unexpected uninstall failure",
      });

      expect(io.stdout()).toContain("uninstall refused");
      expect(io.stderr()).toBe("");
      expect(exitCode).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
