import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";

import { runtimeProviderService } from "../../src/runtime/bootstrap-layer-support.ts";

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
});
