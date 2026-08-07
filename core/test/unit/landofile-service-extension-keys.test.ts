import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit } from "effect";

import { LandofileValidationError } from "@lando/core/errors";
import { LandofileService } from "@lando/core/services";
import { LandofileServiceLive } from "@lando/engine/services/landofile-live";

const withTempCwd = async <T>(run: (directory: string) => Promise<T>): Promise<T> => {
  const directory = await mkdtemp(join(tmpdir(), "lando-service-extension-keys-"));
  const previousCwd = process.cwd();
  try {
    process.chdir(directory);
    return await run(directory);
  } finally {
    process.chdir(previousCwd);
    await rm(directory, { recursive: true, force: true });
  }
};

const discover = () =>
  Effect.flatMap(LandofileService, (service) => service.discover).pipe(Effect.provide(LandofileServiceLive));

describe("LandofileService authored service extension keys", () => {
  test("Given a raw YAML service x-* key, when loaded, then discovery succeeds", async () => {
    await withTempCwd(async (directory) => {
      // Given
      await writeFile(
        join(directory, ".lando.yml"),
        `name: extension-app
services:
  web:
    image: nginx:alpine
    x-foo:
      opaque: true
`,
      );

      // When
      const landofile = await Effect.runPromise(discover());

      // Then
      expect(landofile.name).toBe("extension-app");
    });
  });

  test("Given a raw YAML unknown non-x-* service key, when loaded, then validation fails", async () => {
    await withTempCwd(async (directory) => {
      // Given
      await writeFile(
        join(directory, ".lando.yml"),
        `name: invalid-app
services:
  web:
    image: nginx:alpine
    unsupported_foo: true
`,
      );

      // When
      const exit = await Effect.runPromiseExit(discover());

      // Then
      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) throw new Error("expected discovery to fail");
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag !== "Some") throw new Error("expected a typed failure");
      expect(failure.value).toBeInstanceOf(LandofileValidationError);
    });
  });
});
