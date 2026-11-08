import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect } from "effect";
import { destroyApp } from "../../src/operations/destroy.ts";
import { rebuildApp } from "../../src/operations/rebuild.ts";
import { restartApp } from "../../src/operations/restart.ts";
import { stopApp } from "../../src/operations/stop.ts";
import { fixture, target } from "./legacy-teardown-support.ts";
import { web } from "./start-progress-topology-support.ts";

test.each(["stop", "destroy", "restart", "rebuild"] as const)(
  "%s does not prepare a runtime before legacy teardown or selected rename refusal",
  async (command) => {
    const harness = fixture();
    let preparations = 0;
    try {
      const base = await Effect.runPromise(harness.runtimeProviderRegistry.select());
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          switch (command) {
            case "stop":
              return yield* stopApp({}, target);
            case "destroy":
              return yield* destroyApp({}, target);
            case "restart":
              return yield* restartApp({ services: [web.name] }, target);
            case "rebuild":
              return yield* rebuildApp({ services: [web.name] }, target);
          }
        }).pipe(
          Effect.provideService(RuntimeProviderRegistry, {
            ...harness.runtimeProviderRegistry,
            select: () =>
              Effect.succeed({
                ...base,
                ensureReady:
                  Effect.sync(() => {
                    preparations++;
                  }),
              }),
          }),
          Effect.provide(harness.layer),
          Effect.result,
        ),
      );
      expect(result).toMatchObject(
        command === "stop" || command === "destroy"
          ? { _tag: "Success" }
          : {
              _tag: "Failure",
              failure: { _tag: "AppResolveError", reason: "mismatch", detail: "applied-state" },
            },
      );
      expect(preparations).toBe(0);
    } finally {
      rmSync(harness.userDataRoot, { recursive: true, force: true });
    }
  },
);
