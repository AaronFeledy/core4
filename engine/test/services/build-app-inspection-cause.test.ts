import { expect, test } from "bun:test";
import { ProviderInternalError } from "@lando/sdk/errors";
import type { RuntimeProviderShape } from "@lando/sdk/services";
import { BuildOrchestrator } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Cause, Effect, Exit, Stream } from "effect";
import { makeLayer, planWith, providerId, withTempRoots } from "./build-app-runner-test-support.ts";

const providerError = new ProviderInternalError({
  providerId,
  operation: "inspect",
  message: "Cannot inspect container",
  remediation: "Check the provider.",
});
const defect = "inspect-cleanup-defect";
const interrupt = Effect.failCause(Cause.interrupt(2297));

for (const scenario of [
  { name: "direct defect", inspect: Effect.die(defect), tags: ["Die"], typed: false },
  { name: "direct interrupt", inspect: interrupt, tags: ["Interrupt"], typed: false },
  {
    name: "typed failure with cleanup defect",
    inspect: Effect.fail(providerError).pipe(Effect.ensuring(Effect.die(defect))),
    tags: ["Fail", "Die"],
    typed: true,
  },
  {
    name: "typed failure with cleanup interrupt",
    inspect: Effect.fail(providerError).pipe(Effect.ensuring(interrupt)),
    tags: ["Fail", "Interrupt"],
    typed: true,
  },
] as const) {
  test(`app inspection preserves ${scenario.name} without dispatching commands`, async () => {
    await withTempRoots(async () => {
      let commands = 0;
      const provider = {
        ...TestRuntimeProvider,
        inspect: () => scenario.inspect,
        execStream: () => {
          commands += 1;
          return Stream.make({ exitCode: 0 });
        },
      } satisfies RuntimeProviderShape;
      const plan = planWith({ web: [{ id: "install", phase: "app", command: { command: ["install"] } }] });

      const exit = await Effect.runPromiseExit(
        Effect.flatMap(BuildOrchestrator, (build) => build.buildApp(plan)).pipe(
          Effect.provide(makeLayer(provider)),
        ),
      );

      expect(commands).toBe(0);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isSuccess(exit)) throw new TypeError("inspection unexpectedly recovered");
      expect(exit.cause.reasons.map((reason) => reason._tag)).toEqual([...scenario.tags]);
      expect(exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error)).toEqual(
        scenario.typed ? [providerError] : [],
      );
      expect(exit.cause.reasons.filter(Cause.isDieReason).map((reason) => reason.defect)).toEqual(
        scenario.tags.some((tag) => tag === "Die") ? [defect] : [],
      );
      expect(exit.cause.reasons.filter(Cause.isInterruptReason).map((reason) => reason.fiberId)).toEqual(
        scenario.tags.some((tag) => tag === "Interrupt") ? [2297] : [],
      );
    });
  });
}

test("app inspection recovers a typed failure alone as a cache miss", async () => {
  await withTempRoots(async () => {
    let commands = 0;
    const provider = {
      ...TestRuntimeProvider,
      inspect: () => Effect.fail(providerError),
      execStream: () => {
        commands += 1;
        return Stream.make({ exitCode: 0 });
      },
    } satisfies RuntimeProviderShape;
    const plan = planWith({ web: [{ id: "install", phase: "app", command: { command: ["install"] } }] });

    await Effect.runPromise(
      Effect.flatMap(BuildOrchestrator, (build) => build.buildApp(plan)).pipe(
        Effect.provide(makeLayer(provider)),
      ),
    );

    expect(commands).toBe(1);
  });
});
