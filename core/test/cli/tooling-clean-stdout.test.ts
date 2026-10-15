import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBunShellTooling } from "@lando/engine/operations/tooling-bun-script";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect } from "effect";
import { renderRunToolingResult } from "../../src/cli/commands/tooling.ts";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";

test.each(["alpha\nbeta\n", "no-newline"])(
  "script tooling preserves %j through the default renderer boundary",
  async (payload) => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "lando-clean-stdout-"));
    const io = createBufferedRendererIO({ isTTY: false });
    try {
      await mkdir(join(root, ".lando/scripts"), { recursive: true });
      await writeFile(
        join(root, ".lando/scripts/gen.bun.sh"),
        `# ---\n# desc: Generate output\n# ---\nprintf '${payload}'\n`,
      );

      // When
      await runWithRendererHandling(
        runBunShellTooling({ name: "gen", renderProgress: true }, root).pipe(
          Effect.map((result) => {
            if (result === undefined) throw new Error("fixture script missing");
            return result;
          }),
        ),
        {
          runtime: PrivateFileAccessService.layer,
          rendererMode: "lando",
          streamingMode: "live",
          io,
          render: renderRunToolingResult,
          formatError: String,
          setExitCode: (code) => expect(code).toBe(0),
        },
      );

      // Then
      expect(io.stdout()).toBe(payload);
      expect(io.stderr()).toContain("▼ app:gen (1 step)");
      expect(io.stderr()).toContain("✓ complete");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
