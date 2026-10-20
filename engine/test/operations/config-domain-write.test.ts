import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LandofileWriteValidationError } from "@lando/sdk/errors";
import { ConfigService } from "@lando/sdk/services";
import { Effect, Result } from "effect";
import { config } from "../../src/operations/config.ts";

test.each([false, true])("rejects invalid proxy.defaultDomain before writing (dryRun=%s)", async (dryRun) => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-config-domain-"));
  const file = join(root, "config.yml");
  const before = "renderer: json\nproxy:\n  defaultDomain: lando.test\n";
  try {
    await writeFile(file, before);
    // When
    const result = await Effect.runPromise(
      config({
        subcommand: "set",
        key: "proxy.defaultDomain",
        value: "x.test:80/a",
        configPath: file,
        dryRun,
      }).pipe(
        Effect.provideService(ConfigService, { load: Effect.die("unused"), get: () => Effect.die("unused") }),
        Effect.result,
      ),
    );
    // Then
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(LandofileWriteValidationError);
      if (result.failure instanceof LandofileWriteValidationError)
        expect(result.failure.issues.map(({ path }) => path)).toEqual([["proxy", "defaultDomain"]]);
    }
    expect(await readFile(file, "utf8")).toBe(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
