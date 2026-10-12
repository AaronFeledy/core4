import { expect, test } from "bun:test";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runHostShellLine } from "../../src/services/host-shell-line.ts";

test.skipIf(process.platform === "win32").each([false, true])(
  "standalone evaluator uses %s host Bun availability without changing lando",
  async (hostBun) => {
    // Given: an executable distinguishes embedded Bun from Lando, with an optional host Bun.
    const root = await mkdtemp(join(tmpdir(), "lando-host-line-env-"));
    const stdout: string[] = [];
    const stderr: string[] = [];
    try {
      const bin = join(root, "bin");
      await mkdir(bin);
      const binary = join(bin, "lando");
      await writeFile(
        binary,
        '#!/bin/sh\nif [ "$BUN_BE_BUN" = 1 ]; then printf "embedded-bun\\n"; else printf "lando:%s:%s\\n" "${BUN_BE_BUN-unset}" "${BUN_FEATURE_FLAG_NO_ORPHANS-unset}"; fi\n',
        { mode: 0o700 },
      );
      if (hostBun) await writeFile(join(bin, "bun"), '#!/bin/sh\nprintf "host-bun\\n"\n', { mode: 0o700 });
      // When
      const result = await runHostShellLine({
        fragments: ["bun --version; lando version; which bun"],
        values: [],
        cwd: root,
        env: { PATH: bin },
        runtime: { standalone: true, execPath: binary, platform: process.platform },
        writeStdout: stdout.push.bind(stdout),
        writeStderr: stderr.push.bind(stderr),
      });
      // Then
      expect(result.exitCode, stderr.join("")).toBe(0);
      const lines = stdout.join("").trim().split("\n");
      expect(lines[0]).toBe(hostBun ? "host-bun" : "embedded-bun");
      expect(lines[1]).toBe("lando:unset:unset");
      const bunPath = lines[2];
      if (bunPath === undefined) throw new TypeError("Missing bun path");
      if (hostBun) expect(bunPath).toBe(join(bin, "bun"));
      else {
        expect(dirname(bunPath)).not.toBe(bin);
        expect(await access(dirname(bunPath)).catch((cause: unknown) => cause)).toMatchObject({
          code: "ENOENT",
        });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
