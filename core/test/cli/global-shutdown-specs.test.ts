import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as LandoEventService from "@lando/engine/services/event-service";
import { globalPlanAt, globalTeardownHarness } from "@lando/engine/testing/global-teardown";
import { createBufferedRendererIO } from "@lando/renderer/io";
import {
  AbsolutePath,
  AppId,
  ProviderId,
  ServiceName,
  type ServiceShutdownObservation,
} from "@lando/sdk/schema";
import { Effect, Layer } from "effect";
import { metaGlobalDestroySpec } from "../../src/cli/command-specs/meta/global/destroy.ts";
import { metaGlobalStopSpec } from "../../src/cli/command-specs/meta/global/stop.ts";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";
for (const spec of [metaGlobalStopSpec, metaGlobalDestroySpec]) {
  test.each(["text", "json"] as const)(`${spec.id} receipts in %s output`, async (format) => {
    // Given an applied global app whose provider observed OOM and an inspect failure.
    const root = await mkdtemp(join(tmpdir(), "global-shutdown-spec-"));
    try {
      const identity = {
        appId: AppId.make("global"),
        providerId: ProviderId.make("lando"),
        service: ServiceName.make("ssh-agent"),
      };
      const observations: readonly ServiceShutdownObservation[] = [
        { ...identity, containerId: "agent-current", status: "exited", exitCode: 137, oomKilled: true },
        {
          ...identity,
          containerId: "agent-old",
          status: "unknown",
          reason: "inspect-failed",
          diagnostic: {
            _tag: "ProviderRequestError",
            message: "inspect timed out",
            remediation: "Retry inspect.",
          },
        },
      ];
      const harness = await globalTeardownHarness(root, {
        plan: globalPlanAt(AbsolutePath.make(join(root, "global"))),
        destroyOutcome: { kind: "destroyed", shutdownObservations: observations },
      });
      const io = createBufferedRendererIO();
      const codes: number[] = [];
      // When the real declarative command executes through the renderer boundary.
      await runWithRendererHandling(
        Effect.gen(function* () {
          return yield* spec.run({ flags: { yes: true } });
        }),
        {
          runtime: Layer.merge(harness.layer, LandoEventService.layer),
          rendererMode: "plain",
          resultFormat: format,
          command: spec.id,
          resultSchema: spec.resultSchema,
          io,
          sourceEnv: {},
          render: (result) =>
            "servicesStopped" in result
              ? metaGlobalStopSpec.render(result)
              : metaGlobalDestroySpec.render(result),
          setExitCode: (code) => {
            codes.push(code);
          },
          formatError: () => "unexpected global command failure",
        },
      );
      // Then human output and machine envelopes retain facts without losing CLI warning publication.
      expect(codes).not.toContain(1);
      if (format === "json") {
        const envelope = JSON.parse(io.stdout());
        expect(envelope.ok).toBe(true);
        expect(envelope.result.shutdownObservations).toEqual(observations);
        expect(envelope.warnings).toEqual([
          { code: "LANDO_MESSAGE_WARN", message: "ssh-agent: runtime reported OOMKilled (exit 137)." },
          {
            code: "LANDO_MESSAGE_WARN",
            message:
              "ssh-agent: shutdown state could not be inspected (ProviderRequestError): inspect timed out Retry inspect.",
          },
        ]);
        expect(io.stderr()).toBe("");
      } else {
        expect(io.stdout()).toContain("exit 137, OOMKilled");
        expect(io.stdout()).toContain("inspect failed");
        expect(io.stderr()).toContain("runtime reported OOMKilled");
        expect(io.stderr()).toContain("inspect timed out Retry inspect.");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
