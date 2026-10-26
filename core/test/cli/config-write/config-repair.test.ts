import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandWarnings, makeCommandWarnings } from "@lando/engine/landofile/command-warnings";
import { Effect } from "effect";
import { appConfigSet } from "../../../src/cli/commands/app-config.ts";
import { globalConfigSet } from "../../../src/cli/commands/meta/global-config.ts";
import { testStateStoreLayer } from "../../_support/landofile-layer.ts";

test.each(["app", "global"] as const)(
  "%s config set repairs a key while warning about unrelated problems",
  async (surface) => {
    // Given an invalid Landofile with a comment and two bad keys.
    const root = await mkdtemp(join(tmpdir(), "lando-write-repair-"));
    const file = join(root, ".lando.yml");
    try {
      await writeFile(file, "# my comment\nname: demo\nruntime: invalid\nrouter:\n  httpPort: invalid\n");
      const warnings = makeCommandWarnings(true);
      // When repairing only the HTTP port through either public command adapter.
      const outcome = await Effect.runPromise(
        Effect.gen(function* () {
          return surface === "app"
            ? yield* appConfigSet({ key: "router.httpPort", value: "8080", cwd: root })
            : yield* globalConfigSet({ key: "router.httpPort", value: "8080" }, file);
        }).pipe(Effect.provide(testStateStoreLayer), Effect.provideService(CommandWarnings, warnings)),
      );
      // Then the write succeeds with one warning naming the remaining issue and its fix.
      expect(outcome.changed).toBe(true);
      expect(outcome.value).toBe(8080);
      const recorded = await Effect.runPromise(warnings.list);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.code).toBe("LANDO_CONFIG_PREEXISTING_ISSUES");
      expect(recorded[0]?.message).toContain("runtime");
      expect(recorded[0]?.message).toContain("Fix or unset runtime");
      expect(await readFile(file, "utf8")).toBe(
        "# my comment\nname: demo\nruntime: invalid\nrouter:\n  httpPort: 8080\n",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
