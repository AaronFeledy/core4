import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { lastEnvelope, makeFixture, runSource } from "./subprocess-support.ts";

test.each(["text", "json"])(
  "verify annotates disabled missing pins in %s without publishing",
  async (format) => {
    const fixture = await makeFixture("disabled-verify");
    try {
      await writeFile(
        join(fixture.root, ".lando.yml"),
        "name: disabled-verify\nincludes:\n  - source: github:acme/shared\n    path: fragment.yml\n    when: false\n",
      );
      const result = await runSource(fixture, ["app:includes:verify", `--format=${format}`]);
      expect(result.exitCode, result.stderr).toBe(1);
      if (format === "json") {
        expect(lastEnvelope(result.stdout)).toMatchObject({
          ok: true,
          result: {
            ok: false,
            entries: [
              { source: "github:acme/shared/fragment.yml", status: "missing", condition: "disabled" },
            ],
            failures: [],
            mismatches: [
              { remediation: expect.stringContaining("every environment resolves the same revision") },
            ],
          },
        });
      } else {
        expect(result.stdout).toContain("disabled by when in this environment");
        expect(result.stdout).toContain("lando app:includes:update");
        expect(result.stdout).toContain("every environment resolves the same revision");
      }
      expect(await Bun.file(join(fixture.root, ".lando.lock.yml")).exists()).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  },
  30_000,
);
