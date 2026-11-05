import { expect, test } from "bun:test";
import { ContainerUser, ServiceName } from "@lando/sdk/schema";
import { ProcessRunner } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { DateTime, Effect, Stream } from "effect";
import { waitForServiceReadiness } from "../../src/operations/service-readiness.ts";
import { planWith } from "../services/build-app-runner-test-support.ts";

test.each(["host", "user"])("readiness dispatch honors %s execution", async (mode) => {
  // Given
  const web = ServiceName.make("web");
  const check = {
    kind: "command",
    command: ["ready", "$HOME"],
    intervalSeconds: 0,
    timeoutSeconds: 1,
    retries: 1,
    ...(mode === "host" ? { executionTarget: "host" as const } : { user: ContainerUser.make("1001:1002") }),
  } as const;
  const plan = planWith({ web: [] }, { web: { readiness: check } });
  const calls: unknown[] = [];
  const provider = {
    ...TestRuntimeProvider,
    inspect: () =>
      Effect.succeed({
        app: plan.id,
        service: web,
        providerId: plan.provider,
        status: "running" as const,
        publications: { status: "unknown" as const },
        state: "running",
        lastStartedAt: DateTime.toDate(DateTime.makeUnsafe(0)),
      }),
    exec: (
      target: Parameters<typeof TestRuntimeProvider.exec>[0],
      command: Parameters<typeof TestRuntimeProvider.exec>[1],
    ) => {
      calls.push({ target, command });
      return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
    },
  };
  // When
  const rows = await Effect.runPromise(
    waitForServiceReadiness({ provider, plan, services: [web] }).pipe(
      Effect.provideService(
        ProcessRunner,
        ProcessRunner.of({
          run: (options) => {
            calls.push(options);
            return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
          },
          stream: () => Stream.empty,
          streamWithExit: () => Stream.empty,
        }),
      ),
    ),
  );
  // Then
  expect(rows[0]?.state).toBe("ready");
  expect(calls).toEqual(
    mode === "host"
      ? [{ cmd: "ready", args: ["$HOME"], cwd: plan.root, capture: true }]
      : [
          {
            target: { app: plan.id, service: web, plan, user: "1001:1002" },
            command: { command: ["ready", "$HOME"], raw: true },
          },
        ],
  );
});
