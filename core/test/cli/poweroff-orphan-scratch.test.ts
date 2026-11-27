import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbsolutePath, AppId, ProviderId, ServiceName } from "@lando/sdk/schema";
import type { ScratchSummary, ServiceRuntimeInfo } from "@lando/sdk/services";
import { Effect } from "effect";
import { poweroff } from "../../src/cli/commands/poweroff";
import { makePoweroffFixture } from "./poweroff-support";

const providerId = ProviderId.make("lando");
const scratchId = "scratch-orphan-abc123";

const scratchService = (dataRoot: string): ServiceRuntimeInfo => ({
  app: AppId.make(scratchId),
  appRoot: AbsolutePath.make(dataRoot),
  service: ServiceName.make("web"),
  providerId,
  status: "running",
  containerId: "container-web",
  publications: { status: "unknown" },
  labels: { "dev.lando.scratch": "TRUE", "dev.lando.data-root": dataRoot },
});

const summary = (dataRoot: string): ScratchSummary => ({
  id: scratchId,
  app: { kind: "scratch", id: AppId.make(scratchId), root: AbsolutePath.make(dataRoot) },
  source: { kind: "fork" },
  mode: "full",
  created: "2026-08-01T00:00:00.000Z",
  status: "detached",
});

test.each(["orphan", "registered", "destroy-failure"] as const)(
  "poweroff handles %s scratch resources without hiding failures",
  async (mode) => {
    // Given: a labeled scratch container and independently controlled registry state.
    const dataRoot = await realpath(await mkdtemp(join(tmpdir(), "poweroff-orphan-data-")));
    const fixture = await makePoweroffFixture({
      dataRoot,
      services: [scratchService(dataRoot)],
      ...(mode === "orphan" ? {} : { scratch: [summary(dataRoot)] }),
      scratchFailure: mode === "destroy-failure",
    });
    try {
      // When: poweroff reaps the discovered scratch through its lifecycle service.
      const result = await Effect.runPromise(poweroff().pipe(Effect.result, Effect.provide(fixture.layer)));
      // Then: an orphan is destroyed once, and a failure keeps the runtime available.
      if (mode === "destroy-failure") {
        expect(result._tag).toBe("Failure");
        if (result._tag !== "Failure") throw new Error("expected a typed scratch failure");
        expect(result.failure).toMatchObject({
          _tag: "PoweroffStopError",
          failures: [{ kind: "scratch", appId: scratchId, _tag: "ScratchAppError" }],
        });
        expect(fixture.calls).toEqual([`scratch:${scratchId}`, `scratch-reason:${scratchId}`]);
        expect(fixture.calls).not.toContain("runtime");
      } else {
        expect(result._tag).toBe("Success");
        if (result._tag === "Success")
          expect(result.success.apps.find((app) => app.kind === "scratch")).toMatchObject({
            appId: scratchId,
            outcome: "destroyed",
          });
        expect(fixture.calls.filter((call) => call === `scratch:${scratchId}`)).toHaveLength(1);
        expect(fixture.calls.at(-1)).toBe("runtime");
      }
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  },
);
