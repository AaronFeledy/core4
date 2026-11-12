import { expect, test } from "bun:test";
import { AppId, ProviderId, ServiceName } from "@lando/sdk/schema";
import { Effect } from "effect";
import type { EngineHttpRequest } from "../src/engine-api.ts";
import { bringDown } from "../src/podman/bring-down.ts";
import { stopAndRemoveContainer } from "../src/stop-container.ts";
import { networkPlan } from "./authored-network-fixture.ts";

test("stop failures retain the engine reason without exposing secrets or raw response details", async () => {
  // Given
  const secret = "stop-diagnostic-secret-1199";
  // When
  const result = await Effect.runPromise(
    stopAndRemoveContainer(
      {
        appId: AppId.make("shutdown"),
        providerId: ProviderId.make("docker"),
        service: ServiceName.make("web"),
        containerId: "owned",
      },
      {
        ctx: { providerId: "docker", remediation: "retry", env: { DB_PASSWORD: secret } },
        api: {
          request: () =>
            Effect.succeed({
              status: 500,
              body: JSON.stringify({ message: `cannot stop container: ${secret}`, internal: "private-body" }),
            }),
        },
      },
    ).pipe(Effect.result),
  );
  // Then
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: {
      _tag: "ProviderUnavailableError",
      operation: "bringDown.stop",
      message: expect.stringContaining("cannot stop container:"),
      remediation: "retry",
    },
  });
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(JSON.stringify(result)).not.toContain("private-body");
});

test("shutdown inspects and deletes the owned id even when its name has been replaced", async () => {
  // Given
  const web = networkPlan.services[ServiceName.make("web")];
  if (web === undefined) throw new Error("web fixture missing");
  const plan = { ...networkPlan, services: { web }, stores: [] };
  const calls: EngineHttpRequest[] = [];
  let replaced = false;
  // When
  const result = await Effect.runPromise(
    bringDown(plan, {
      ctx: { providerId: "docker", remediation: "retry", env: {} },
      api: {
        request: (input) => {
          calls.push(input);
          if (input.method === "GET" && input.path.startsWith("/containers/json?"))
            return Effect.succeed({ status: 200, body: "[]" });
          if (input.path.startsWith("/networks/")) return Effect.succeed({ status: 404, body: "" });
          if (input.method === "POST") {
            replaced = true;
            return Effect.succeed({ status: 204, body: "" });
          }
          if (input.method === "DELETE") return Effect.succeed({ status: 204, body: "" });
          if (input.path === "/containers/owned-before/json")
            return Effect.succeed({
              status: 200,
              body: '{"State":{"Status":"exited","ExitCode":143,"OOMKilled":false}}',
            });
          return Effect.succeed({
            status: 200,
            body: JSON.stringify({
              Id: replaced ? "replacement" : "owned-before",
              Config: {
                Labels: {
                  "dev.lando.app": plan.id,
                  "dev.lando.app-root": plan.root,
                  "dev.lando.service": web.name,
                },
              },
            }),
          });
        },
      },
    }),
  );
  // Then
  expect(result.shutdownObservations).toEqual([
    {
      appId: plan.id,
      providerId: plan.provider,
      service: web.name,
      containerId: "owned-before",
      status: "exited",
      exitCode: 143,
      oomKilled: false,
    },
  ]);
  expect(
    calls
      .filter((input) => input.path.startsWith("/containers/"))
      .map((input) => `${input.method} ${input.path}`),
  ).toEqual([
    "GET /containers/json?all=true&filters=%7B%22label%22%3A%5B%22dev.lando.app%3Dnetworks%22%5D%7D",
    `GET /containers/lando-${plan.slug}--web/json`,
    "POST /containers/owned-before/stop",
    "GET /containers/owned-before/json",
    "DELETE /containers/owned-before?force=true&v=true",
  ]);
});

test("later cleanup failure retains earlier shutdown facts and the original error cause", async () => {
  // Given
  const web = networkPlan.services[ServiceName.make("web")];
  if (web === undefined) throw new Error("web fixture missing");
  const plan = { ...networkPlan, services: { web }, stores: [] };
  // When
  const result = await Effect.runPromise(
    Effect.result(
      bringDown(plan, {
        ctx: { providerId: "docker", remediation: "retry", env: {} },
        api: {
          request: (input) => {
            if (input.method === "GET" && input.path.startsWith("/containers/json?"))
              return Effect.succeed({ status: 200, body: "[]" });
            if (input.method !== "GET") return Effect.succeed({ status: 204, body: "" });
            if (input.path.startsWith("/networks/"))
              return Effect.succeed({ status: 500, body: "unavailable" });
            return Effect.succeed({
              status: 200,
              body: JSON.stringify({
                Id: "owned",
                Config: {
                  Labels: {
                    "dev.lando.app": plan.id,
                    "dev.lando.app-root": plan.root,
                    "dev.lando.service": web.name,
                  },
                },
                State: { Status: "exited", ExitCode: 143 },
              }),
            });
          },
        },
      }),
    ),
  );
  // Then
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: {
      _tag: "ProviderUnavailableError",
      operation: "resource-ownership",
      cause: { _tag: "ProviderUnavailableError", operation: "resource-ownership" },
      details: { shutdownObservations: [{ service: web.name, exitCode: 143 }] },
    },
  });
});

test.each([
  ["exited", true],
  ["running", false],
] as const)("a failed stop whose container is %s afterwards completes: %p", async (state, completes) => {
  // Given a stop request the engine rejects, as Podman does when the container's monitor was killed.
  const calls: string[] = [];
  const result = await Effect.runPromise(
    stopAndRemoveContainer(
      {
        appId: AppId.make("shutdown"),
        providerId: ProviderId.make("lando"),
        service: ServiceName.make("web"),
        containerId: "owned",
      },
      {
        ctx: { providerId: "lando", remediation: "retry", env: {} },
        api: {
          request: (input) => {
            calls.push(`${input.method} ${input.path}`);
            if (input.method === "POST")
              return Effect.succeed({
                status: 500,
                body: JSON.stringify({ message: "conmon exited prematurely" }),
              });
            if (input.method === "GET")
              return Effect.succeed({
                status: 200,
                body: JSON.stringify({
                  State:
                    state === "exited"
                      ? { Status: "exited", Running: false, ExitCode: 137 }
                      : { Status: "running", Running: true },
                }),
              });
            return Effect.succeed({ status: 204, body: "" });
          },
        },
      },
    ).pipe(Effect.result),
  );
  // Then an exited container is removed and only a still-running one keeps the stop failure.
  if (completes) {
    expect(result).toMatchObject({ _tag: "Success", success: { changed: true, kind: "removed" } });
    expect(calls.some((call) => call.startsWith("DELETE /containers/owned"))).toBe(true);
  } else {
    expect(result).toMatchObject({ _tag: "Failure", failure: { operation: "bringDown.stop" } });
    expect(calls.some((call) => call.startsWith("DELETE"))).toBe(false);
  }
});
