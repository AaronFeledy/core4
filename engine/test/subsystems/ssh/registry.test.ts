import { expect, test } from "bun:test";
import { SshError } from "@lando/sdk/errors";
import type { LandoPluginModule } from "@lando/sdk/plugins";
import { PluginManifest } from "@lando/sdk/schema";
import { SshService } from "@lando/sdk/services";
import { makeTestSshService } from "@lando/sdk/test";
import { Effect, Layer, Result, Schema } from "effect";
import { SshServiceRegistry } from "../../../src/subsystems/ssh/registry.ts";

const moduleFor = (id: string): LandoPluginModule => {
  const manifest = Schema.decodeUnknownSync(PluginManifest)({
    name: id,
    version: "1.0.0",
    api: 4,
    contributes: { sshServices: [{ id, module: "./ssh.ts" }] },
  });
  return {
    name: manifest.name,
    manifest,
    sshServices: new Map([[id, Layer.succeed(SshService, makeTestSshService())]]),
  };
};

test("SSH defaults to the first contribution but honors an explicit later id", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* SshServiceRegistry;
      return {
        ids: yield* registry.list,
        defaultId: (yield* registry.select()).id,
        explicitId: (yield* registry.select({ explicit: "second" })).id,
      };
    }).pipe(Effect.provide(SshServiceRegistry.layerWith([moduleFor("first"), moduleFor("second")]))),
  );
  expect(result).toEqual({ ids: ["first", "second"], defaultId: "first", explicitId: "second" });
});

test.each([
  { explicit: "missing", message: "SSH service missing is not installed.", sshId: "missing" },
  { explicit: undefined, message: "No SshService plugin could be selected unambiguously.", sshId: "unknown" },
])("SSH preserves selection errors for $sshId", async ({ explicit, message, sshId }) => {
  const result = await Effect.runPromise(
    Effect.flatMap(SshServiceRegistry, (registry) =>
      registry.select(explicit === undefined ? {} : { explicit }),
    ).pipe(Effect.provide(SshServiceRegistry.layerWith([])), Effect.result),
  );
  expect(result).toEqual(Result.fail(new SshError({ message, sshId })));
});

test("SSH discards the duplicate-index cause in its discovery error", async () => {
  const result = await Effect.runPromise(
    SshServiceRegistry.pipe(
      Effect.provide(SshServiceRegistry.layerWith([moduleFor("same"), moduleFor("same")])),
      Effect.result,
    ),
  );
  expect(result).toEqual(
    Result.fail(new SshError({ message: "Unable to discover SshService contributions.", sshId: "unknown" })),
  );
});
