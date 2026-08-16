import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { type RuntimeSetupPhase, setupProviderLando } from "../src/setup.ts";

const podmanApi = {
  info: Effect.succeed({ version: { Version: "6.0.2" } }),
  ping: Effect.void,
};

describe("provider-lando setup smoke step", () => {
  test("emits and resolves smoke after readiness when enabled", async () => {
    const phases: RuntimeSetupPhase[] = [];

    await Effect.runPromise(
      setupProviderLando({
        platform: "linux",
        podmanApi,
        podmanCommand: { version: Effect.succeed("podman version 6.0.2") },
        smoke: true,
        managedRuntimeSetup: (progress) =>
          Effect.gen(function* () {
            for (const phase of ["prerequisites", "launch", "readiness", "smoke"] as const) {
              yield* progress.run(
                phase,
                Effect.sync(() => phases.push(phase)),
              );
            }
          }),
      }),
    );

    expect(phases).toEqual(["prerequisites", "launch", "readiness", "smoke"]);
  });

  test("keeps the previous managed step list and never resolves smoke when disabled", async () => {
    const phases: RuntimeSetupPhase[] = [];

    await Effect.runPromise(
      setupProviderLando({
        platform: "linux",
        podmanApi,
        podmanCommand: { version: Effect.succeed("podman version 6.0.2") },
        managedRuntimeSetup: (progress) =>
          Effect.gen(function* () {
            for (const phase of ["prerequisites", "launch", "readiness"] as const) {
              yield* progress.run(
                phase,
                Effect.sync(() => phases.push(phase)),
              );
            }
          }),
      }),
    );

    expect(phases).toEqual(["prerequisites", "launch", "readiness"]);
  });
});
