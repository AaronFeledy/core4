import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLandofileLayers } from "@lando/landofile/service";
import { LandofileValidationError } from "@lando/sdk/errors";
import { PluginRegistry } from "@lando/sdk/services";
import { Effect, Result } from "effect";
import { appConfigLint } from "../../src/operations/app-config-lint.ts";
import { resolveKnownEventSet } from "../../src/planner/event-set.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";

test("lint reports DNS violations and planning fails with aggregated validation errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-dns-lint-"));
  try {
    await writeFile(
      join(root, ".lando.yml"),
      "name: shop\nservices:\n  web:\n    type: compose\n    image: nginx:alpine\n  api:\n    type: compose\n    image: nginx:alpine\n    hostnames: [web, lando-shop--db]\n",
    );
    const lint = await Effect.runPromise(
      appConfigLint({ cwd: root }).pipe(Effect.provide(PluginRegistryLayer.layer)),
    );
    const planned = await Effect.runPromise(
      Effect.gen(function* () {
        const landofile = yield* loadLandofileLayers(root, join(root, ".lando.yml"));
        return yield* resolveKnownEventSet({
          landofile,
          pluginRegistry: yield* PluginRegistry,
          configService: undefined,
          fileSystem: undefined,
          pathsService: undefined,
          appRoot: root,
          file: join(root, ".lando.yml"),
        });
      }).pipe(Effect.provide(PluginRegistryLayer.layer), Effect.result),
    );
    expect(lint.valid).toBe(false);
    expect(lint.violations.map(({ rule, path, severity }) => ({ rule, path, severity }))).toEqual([
      { rule: "landofile.dns-name", path: ["services", "api", "hostnames", 0], severity: "error" },
      { rule: "landofile.dns-name", path: ["services", "api", "hostnames", 1], severity: "error" },
    ]);
    if (Result.isSuccess(planned)) throw new Error("Expected DNS validation failure");
    expect(planned.failure).toBeInstanceOf(LandofileValidationError);
    if (planned.failure instanceof LandofileValidationError)
      expect(planned.failure.issues.map(({ path }) => path)).toEqual(lint.violations.map(({ path }) => path));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
