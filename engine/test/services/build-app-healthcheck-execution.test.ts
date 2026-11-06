import { expect, test } from "bun:test";
import { ContainerUser, ServiceName } from "@lando/sdk/schema";
import { BuildOrchestrator, ProcessRunner } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer, Result, Stream } from "effect";
import { makeLayer, planWith, withTempRoots } from "./build-app-runner-test-support.ts";

const db = ServiceName.make("db");
const probe = {
  kind: "command",
  command: ["ready", "literal arg", "$HOME"],
  executionTarget: "host",
  intervalSeconds: 0,
  timeoutSeconds: 1,
  retries: 1,
} as const;
const plan = planWith(
  { db: [], web: [{ id: "install", phase: "app", command: { command: ["install"] } }] },
  {
    db: { readiness: probe },
    web: { dependsOn: [{ service: db, condition: "service_healthy", required: true }] },
  },
);

test("app build gates use captured host runners before dependent builds", async () =>
  withTempRoots(async () => {
    // Given
    const calls: unknown[] = [];
    const provider = {
      ...TestRuntimeProvider,
      exec: () => {
        calls.push("wrong-container");
        return Effect.succeed({ exitCode: 42, stdout: "", stderr: "" });
      },
      execStream: () => {
        calls.push("build");
        return Stream.make({ exitCode: 0 });
      },
    };
    const hostLayer = Layer.succeed(
      ProcessRunner,
      ProcessRunner.of({
        run: (options) => {
          calls.push(options);
          return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
        },
        stream: () => Stream.empty,
        streamWithExit: () => Stream.empty,
      }),
    );
    // When
    await Effect.runPromise(
      Effect.flatMap(BuildOrchestrator, (build) => build.buildApp(plan)).pipe(
        Effect.provide(makeLayer(provider).pipe(Layer.provide(hostLayer))),
      ),
    );
    // Then
    expect(calls).toEqual([
      { cmd: "ready", args: ["literal arg", "$HOME"], cwd: plan.root, capture: true },
      "build",
    ]);
  }));

test("missing host runners reject before app build or container exec", async () =>
  withTempRoots(async () => {
    // Given
    const calls: string[] = [];
    const provider = {
      ...TestRuntimeProvider,
      exec: () => {
        calls.push("exec");
        return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
      },
      execStream: () => {
        calls.push("build");
        return Stream.make({ exitCode: 0 });
      },
    };
    // When
    const result = await Effect.runPromise(
      Effect.flatMap(BuildOrchestrator, (build) => Effect.result(build.buildApp(plan))).pipe(
        Effect.provide(makeLayer(provider)),
      ),
    );
    // Then
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure._tag).toBe("HealthcheckTargetUnsupportedError");
    expect(calls).toEqual([]);
  }));

test("app build service gates forward their own user rather than the build-step user", async () =>
  withTempRoots(async () => {
    // Given
    const calls: unknown[] = [];
    const planned = planWith(
      { db: [], web: [{ id: "install", phase: "app", user: "root", command: { command: ["install"] } }] },
      {
        db: {
          readiness: {
            kind: "command",
            command: ["id", "-u"],
            user: ContainerUser.make("1001:1002"),
            intervalSeconds: 0,
            timeoutSeconds: 1,
            retries: 1,
          },
        },
        web: { dependsOn: [{ service: db, condition: "service_healthy", required: true }] },
      },
    );
    const provider = {
      ...TestRuntimeProvider,
      exec: (
        target: Parameters<typeof TestRuntimeProvider.exec>[0],
        command: Parameters<typeof TestRuntimeProvider.exec>[1],
      ) => {
        calls.push({ target, command });
        return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
      },
      execStream: (target: Parameters<typeof TestRuntimeProvider.execStream>[0]) => {
        calls.push(target);
        return Stream.make({ exitCode: 0 });
      },
    };
    // When
    await Effect.runPromise(
      Effect.flatMap(BuildOrchestrator, (build) => build.buildApp(planned)).pipe(
        Effect.provide(makeLayer(provider)),
      ),
    );
    // Then
    expect(calls).toEqual([
      {
        target: { app: planned.id, service: db, plan: planned, user: "1001:1002" },
        command: { command: ["id", "-u"], raw: true },
      },
      { app: planned.id, service: "web", user: "root" },
    ]);
  }));
