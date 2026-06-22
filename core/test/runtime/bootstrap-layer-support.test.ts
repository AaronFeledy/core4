import { describe, expect, test } from "bun:test";
import { Effect, Exit, Stream } from "effect";

import { runtimeProviderService } from "../../src/runtime/bootstrap-layer-support.ts";

const expectUnsupportedStreamFailure = <A, E>(exit: Exit.Exit<A, E>, operation: string) => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (exit._tag === "Failure") {
    expect(exit.cause.toString()).toContain("ProviderUnavailableError");
    expect(exit.cause.toString()).toContain(operation);
  }
};

describe("bootstrap runtime provider stub", () => {
  test("fails closed for unsupported volume operations", async () => {
    const listExit = await Effect.runPromiseExit(
      runtimeProviderService.listVolumes({ app: "myapp" as never }),
    );
    const removeExit = await Effect.runPromiseExit(
      runtimeProviderService.removeVolume({ app: "myapp" as never, store: "data" }),
    );

    expect(Exit.isFailure(listExit)).toBe(true);
    if (listExit._tag === "Failure") {
      expect(listExit.cause.toString()).toContain("cannot list volumes");
    }
    expect(Exit.isFailure(removeExit)).toBe(true);
    if (removeExit._tag === "Failure") {
      expect(removeExit.cause.toString()).toContain("cannot remove volumes");
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
