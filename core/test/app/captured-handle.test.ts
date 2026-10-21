import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoRuntime, resolveApp } from "@lando/core";
import { AbsolutePath, ProviderId } from "@lando/core/schema";
import { LandofileService, RuntimeProviderRegistry } from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/core/testing";
import { Effect, Layer, Stream } from "effect";

test("public captured handle reuses configuration until resolution while emergency controls remain live", async () => {
  const root = await mkdtemp(join(tmpdir(), "captured-library-"));
  const file = join(root, ".lando.yml");
  const document = (enabled: boolean) =>
    `name: captured-library\nprovider: test\nagentEnv: ${enabled}\nservices:\n  web:\n    type: node:lts\n    primary: true\ntooling:\n  probe:\n    service: web\n    cmd: "echo {{ app.name }}"\n`;
  await writeFile(file, document(true));
  const forwarded: (string | undefined)[] = [];
  let discoveries = 0;
  const saved = { marker: process.env.CLAUDECODE, veto: process.env.LANDO_AGENT_ENV };
  process.env.CLAUDECODE = "1";
  Reflect.deleteProperty(process.env, "LANDO_AGENT_ENV");
  const provider = {
    ...TestRuntimeProvider,
    execStream: (
      _target: Parameters<typeof TestRuntimeProvider.execStream>[0],
      spec: Parameters<typeof TestRuntimeProvider.execStream>[1],
    ) => {
      forwarded.push(spec.env?.CLAUDECODE);
      return Stream.make({ exitCode: 0 });
    },
  };
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const layer = makeLandoRuntime({
          bootstrap: "app",
          cwd: root,
          plugins: {
            policy: "bundled-only",
            layers: [
              Layer.succeed(
                RuntimeProviderRegistry,
                RuntimeProviderRegistry.of({
                  appliedPlansFor: () => Effect.succeed([]),
                  list: Effect.succeed([ProviderId.make("test")]),
                  capabilities: Effect.succeed(provider.capabilities),
                  select: () => Effect.succeed(provider),
                }),
              ),
            ],
          },
        });
        yield* Effect.gen(function* () {
          const service = yield* LandofileService;
          const counted = LandofileService.of({
            ...service,
            discover: service.discover.pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  discoveries++;
                }),
              ),
            ),
          });
          yield* Effect.gen(function* () {
            const selector = { root: AbsolutePath.make(root) };
            const app = yield* resolveApp(selector);
            expect(discoveries).toBe(1);
            yield* Effect.promise(() => writeFile(file, document(false)));
            yield* app.exec({ command: ["env"] });
            yield* app.tooling("probe");
            expect((yield* app.info({ deep: true })).agentEnv?.forwarded).toContain("CLAUDECODE");
            yield* app.info();
            expect(discoveries).toBe(1);
            process.env.LANDO_AGENT_ENV = "0";
            yield* app.exec({ command: ["env"] });
            expect((yield* app.info({ deep: true })).agentEnv?.enabled).toBe(false);
            Reflect.deleteProperty(process.env, "LANDO_AGENT_ENV");
            const refreshed = yield* resolveApp(selector);
            expect(discoveries).toBe(2);
            yield* refreshed.exec({ command: ["env"] });
            expect((yield* refreshed.info({ deep: true })).agentEnv?.enabled).toBe(false);
            expect(discoveries).toBe(2);
          }).pipe(Effect.provideService(LandofileService, counted));
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped),
    );
    expect(forwarded).toEqual(["1", "1", undefined, undefined]);
  } finally {
    if (saved.marker === undefined) Reflect.deleteProperty(process.env, "CLAUDECODE");
    else process.env.CLAUDECODE = saved.marker;
    if (saved.veto === undefined) Reflect.deleteProperty(process.env, "LANDO_AGENT_ENV");
    else process.env.LANDO_AGENT_ENV = saved.veto;
    await rm(root, { recursive: true, force: true });
  }
});
