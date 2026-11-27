import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.skipIf(process.getuid === undefined || process.getuid() === 0)(
  "the internal repair route sends an euid refusal without bootstrapping invalid Lando configuration",
  () => {
    // Given
    const cwd = mkdtempSync(join(tmpdir(), "lando-internal-repair-"));
    try {
      writeFileSync(join(cwd, "config.yml"), "not: [valid");
      mkdirSync(join(cwd, "config.d"));
      // A config reader would block on this drop-in instead of reaching the euid check.
      expect(Bun.spawnSync(["mkfifo", join(cwd, "config.d", "block.yml")]).exitCode).toBe(0);
      const entry = new URL("../../bin/lando.ts", import.meta.url);

      // When
      const child = Bun.spawnSync(
        [
          process.execPath,
          Bun.fileURLToPath(entry),
          "__internal:repair-root-ownership",
          "--uid",
          "1000",
          "--gid",
          "1000",
          "--root",
          "/data",
          "--storage",
          "/data/storage",
          "--path",
          "/data/file",
        ],
        { cwd, env: { ...process.env, LANDO_USER_CONF_ROOT: cwd }, timeout: 2_000 },
      );

      // Then
      expect(child.exitCode).toBe(2);
      expect(child.stderr.toString()).toBe("");
      const [report, ...after] = child.stdout.toString().split("\n");
      expect(after).toEqual([""]);
      expect(JSON.parse(report ?? "")).toEqual({ refused: "not-root" });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  },
);
