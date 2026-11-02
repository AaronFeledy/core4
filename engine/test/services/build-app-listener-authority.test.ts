import { expect, test } from "bun:test";
import { ServiceName } from "@lando/sdk/schema";
import { BuildOrchestrator } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Stream } from "effect";
import { makeLayer, planWith, withTempRoots } from "./build-app-runner-test-support.ts";

test.each([true, false])("uses dependency authority only for a failed healthy gate: %s", async (gated) => {
  await withTempRoots(async () => {
    // Given different dependency and consumer authorities, with unavailable /proc evidence.
    const plan = planWith(
      { db: [], web: [{ id: "install", phase: "app", command: { command: ["install"] } }] },
      {
        db: {
          healthcheck: {
            kind: "command",
            command: ["ready"],
            retries: 1,
            intervalSeconds: 0,
            timeoutSeconds: 5,
          },
          endpoints: [{ _tag: "internal", protocol: "tcp", port: 6380, primary: true }],
          listenerAuthority: { owner: "launcher", daemon: "Redis", port: 6380, setting: "--port 6380" },
        },
        web: {
          dependsOn: gated
            ? [{ service: ServiceName.make("db"), condition: "service_healthy", required: true }]
            : [],
          listenerAuthority: { owner: "application", daemon: "node", port: 3000, variables: ["PORT"] },
        },
      },
    );
    // When either the healthy gate or the ordinary build command fails.
    const error = await Effect.runPromise(
      Effect.flip(Effect.flatMap(BuildOrchestrator, (orchestrator) => orchestrator.buildApp(plan))).pipe(
        Effect.provide(
          makeLayer({
            ...TestRuntimeProvider,
            exec: () => Effect.succeed({ exitCode: 1, stdout: "", stderr: "not ready" }),
            execStream: () => Stream.make({ exitCode: 1 }),
          }),
        ),
      ),
    );
    // Then only a gate failure receives dependency advice, without invented socket evidence.
    if (error._tag !== "BuildPhaseFailedError") throw error;
    expect(error.listener).toBeUndefined();
    if (gated) {
      expect(error.remediation.split("\n")[0]).toBe(
        "Pass `--port 6380` to Redis in your command or entrypoint; Lando sets the listener from port: only in its own launcher.",
      );
      expect(error.remediation).toContain("lando logs -s db");
    } else {
      expect(error.remediation).not.toContain("listener");
    }
    expect(error.remediation).not.toContain("your application owns");
  });
});
