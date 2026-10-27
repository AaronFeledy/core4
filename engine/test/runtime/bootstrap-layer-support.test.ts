import { describe, expect, test } from "bun:test";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { Cause, Effect, Exit, Option, Stream } from "effect";

import { runtimeProviderService } from "../../src/runtime/bootstrap-layer-support.ts";

const expectUnsupportedStreamFailure = <A, E>(exit: Exit.Exit<A, E>, operation: string) => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (exit._tag === "Failure") {
    expect(exit.cause.toString()).toContain("ProviderUnavailableError");
    expect(exit.cause.toString()).toContain(operation);
  }
};

describe("bootstrap runtime provider stub", () => {
  for (const [operation, member] of Object.entries(runtimeProviderService)) {
    if (operation === "isAvailable") continue;
    const result: unknown =
      typeof member === "function" ? Reflect.apply(member, runtimeProviderService, []) : member;
    const effect = Stream.isStream(result)
      ? Stream.runDrain(result)
      : Effect.isEffect(result)
        ? result
        : undefined;
    if (effect === undefined) continue;
    test(`${operation} refuses with a tagged actionable failure`, async () => {
      // Reflection erases R; the RuntimeProvider contract requires only Scope, supplied here.
      const exit = await Effect.runPromiseExit(Effect.scoped(effect) as Effect.Effect<unknown, unknown>);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
        expect(failure).toBeInstanceOf(ProviderUnavailableError);
        if (failure instanceof ProviderUnavailableError) {
          expect(failure.operation).toBe(operation);
          expect(failure.remediation?.length).toBeGreaterThan(0);
        }
      }
    });
  }
  test("does not advertise architectureEmulation", () => {
    expect(runtimeProviderService.capabilities.architectureEmulation).toBe(false);
  });

  test("fails closed for unsupported volume operations", async () => {
    const listExit = await Effect.runPromiseExit(
      runtimeProviderService.listVolumes({ app: "myapp" as never }),
    );
    const removeExit = await Effect.runPromiseExit(
      runtimeProviderService.removeVolume(
        { app: "myapp" as never, store: "data" },
        "00000000-0000-4000-8000-000000000001",
      ),
    );

    expect(Exit.isFailure(listExit)).toBe(true);
    if (listExit._tag === "Failure") {
      expect(listExit.cause.toString()).toContain("listVolumes");
    }
    expect(Exit.isFailure(removeExit)).toBe(true);
    if (removeExit._tag === "Failure") {
      expect(removeExit.cause.toString()).toContain("removeVolume");
    }
  });

  test("fails closed for unsupported data-plane streams", async () => {
    const runStreamExit = await Effect.runPromiseExit(
      runtimeProviderService
        .runStream({ image: "alpine", command: ["true"] })
        .pipe(Stream.runCollect, Effect.scoped),
    );
    const copyFromServiceExit = await Effect.runPromiseExit(
      runtimeProviderService
        .copyFromService({ app: "myapp" as never, service: "appserver" as never }, {
          sourcePath: "/tmp/out",
        } as never)
        .pipe(Stream.runCollect, Effect.scoped),
    );
    const exportArtifactExit = await Effect.runPromiseExit(
      runtimeProviderService
        .exportArtifact({ providerId: "stub" as never, ref: "web:test" })
        .pipe(Stream.runCollect, Effect.scoped),
    );

    expectUnsupportedStreamFailure(runStreamExit, "runStream");
    expectUnsupportedStreamFailure(copyFromServiceExit, "copyFromService");
    expectUnsupportedStreamFailure(exportArtifactExit, "exportArtifact");
  });
});
