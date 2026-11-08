import { expect, test } from "bun:test";
import { AbsolutePath, AppId, type AppPlan, ProviderId, ServiceName } from "@lando/sdk/schema";
import { DateTime, Effect, Stream } from "effect";
import type { EngineHttpApi } from "../src/engine-api.ts";
import { supervisedExecStream } from "../src/exec-supervision.ts";
import { installSupervisedExecFixture, supervisedExecFixtureOptions } from "./support/exec-supervision.ts";

test("a healthy command survives launch acknowledgement slower than the watch idle budget", async () => {
  const app = AppId.make("slow-launch");
  const service = ServiceName.make("web");
  const provider = ProviderId.make("docker");
  const metadata = {
    source: "exec-slow-launch.test.ts",
    resolvedAt: DateTime.makeUnsafe("2026-11-07T00:00:00Z"),
    runtime: 4 as const,
  };
  const plan: AppPlan = {
    id: app,
    name: "slow-launch",
    slug: "slow-launch",
    root: AbsolutePath.make("/tmp/slow-launch"),
    provider,
    metadata,
    routes: [],
    stores: [],
    fileSync: [],
    extensions: {},
    services: {
      [service]: {
        name: service,
        type: "compose",
        provider,
        primary: true,
        artifact: { kind: "ref", ref: "alpine:3.20" },
        environment: {},
        mounts: [],
        endpoints: [],
        routes: [],
        dependsOn: [],
        hostAliases: [],
        metadata,
        extensions: {},
      },
    },
  };
  const api: EngineHttpApi = {
    request: (input) =>
      Effect.succeed({
        status: 200,
        body: JSON.stringify(
          input.path.startsWith("/containers/") && input.method === "GET"
            ? { Id: "container" }
            : input.method === "POST"
              ? { Id: "main" }
              : { Running: false, ExitCode: 23 },
        ),
      }),
    stream: (input) =>
      Stream.suspend(() => {
        input.onResponseHead?.();
        return Stream.empty;
      }),
  };
  installSupervisedExecFixture(api);
  const request = api.request;
  const stream = api.stream;
  if (request === undefined || stream === undefined) throw new TypeError("Missing fixture transport.");
  const operations = new Map<string, string>();
  Object.assign(api, {
    request: (input: Parameters<NonNullable<EngineHttpApi["request"]>>[0]) =>
      request(input).pipe(
        Effect.tap((response) =>
          Effect.sync(() => {
            const cmd: unknown = input.body;
            if (typeof cmd === "object" && cmd !== null && "Cmd" in cmd && Array.isArray(cmd.Cmd)) {
              const operation: unknown = cmd.Cmd[4];
              if (typeof operation === "string") operations.set(JSON.parse(response.body).Id, operation);
            }
          }),
        ),
      ),
    stream: (input: Parameters<NonNullable<EngineHttpApi["stream"]>>[0]) => {
      const id = /^\/exec\/([^/]+)\/start$/u.exec(input.path)?.[1];
      const operation = id === undefined ? undefined : operations.get(id);
      if (operation === "watch") return stream(input).pipe(Stream.timeout("3 seconds"));
      // Model an engine accepting launch but delaying its acknowledgement within the 7s control limit.
      if (operation === "launch")
        return Stream.unwrap(Effect.sleep("4 seconds").pipe(Effect.as(stream(input))));
      return stream(input);
    },
  });

  const chunks = await Effect.runPromise(
    supervisedExecStream(
      plan,
      { app, service },
      {
        command: ["healthy-command"],
        tty: false,
      },
      {
        api,
        ctx: { providerId: "docker", remediation: "Retry.", env: {} },
        ...supervisedExecFixtureOptions(api),
      },
    ).pipe(Stream.runCollect, Effect.scoped),
  );

  expect(chunks).toEqual([{ exitCode: 23 }]);
}, 15_000);
