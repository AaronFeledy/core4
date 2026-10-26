import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "@lando/sdk/errors";
import { ConfigService, type LandofileServiceError } from "@lando/sdk/services";
import { Effect, Layer } from "effect";
import { lintLandofile } from "../src/lint";
import { loadLandofileLayers } from "../src/service";

const readers: readonly {
  readonly name: string;
  readonly run: (root: string) => Effect.Effect<void, LandofileServiceError>;
}[] = [
  {
    name: "layer loading",
    run: (root: string) => loadLandofileLayers(root, join(root, ".lando.yml")).pipe(Effect.asVoid),
  },
  { name: "lint", run: (root: string) => lintLandofile({ cwd: root }).pipe(Effect.asVoid) },
];

test.each([...readers])("does not enter $name when the host config layer fails", async ({ run }) => {
  // Given a valid app and a config-service failure with structured repair details.
  const root = await mkdtemp(join(tmpdir(), "lando-load-config-error-"));
  const error = new ConfigError({
    path: join(root, "config.yml"),
    message: "Invalid global configuration.",
    issues: [{ path: ["router", "httpPort"], message: "Invalid port." }],
    remediation: "Run `lando config validate`.",
  });
  await writeFile(join(root, ".lando.yml"), "name: x\nservices: {}\n");
  try {
    // When the real loader or lint pipeline needs global configuration.
    const result = await Effect.runPromise(
      Effect.result(run(root).pipe(Effect.provide(Layer.effect(ConfigService, Effect.fail(error))))),
    );
    // Then it fails with the same error, not a parse wrapper or lint violation.
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure).toBe(error);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
