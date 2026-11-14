import { expect, test } from "bun:test";
import { AbsolutePath, AppId, ProviderId, ServiceName } from "@lando/sdk/schema";
import { Effect } from "effect";
import type { EngineHttpApi, EngineHttpRequest } from "../src/engine-api.ts";
import {
  discoverLabeledContainers,
  labelOwnedSnapshots,
  mergeDiscoveredContainers,
} from "../src/podman/discover.ts";

const ctx = { providerId: "podman", remediation: "Check the runtime.", env: {} };

test("discovers labeled services with native container identity and runtime status", async () => {
  const calls: EngineHttpRequest[] = [];
  const api: EngineHttpApi = {
    request: (input) => {
      calls.push(input);
      return Effect.succeed({
        status: 200,
        body: JSON.stringify([
          {
            Id: "running-id",
            State: "running",
            Labels: {
              "dev.lando.app": "orphan",
              "dev.lando.service": "db",
              "dev.lando.app-root": "/tmp/deleted",
            },
          },
          {
            Id: "stopped-id",
            State: "exited",
            Labels: { "dev.lando.app": "orphan", "dev.lando.service": "worker" },
          },
          { Id: "no-service", Labels: { "dev.lando.app": "orphan" } },
          { Id: "no-app", Labels: { "dev.lando.service": "db" } },
        ]),
      });
    },
  };
  const services = await Effect.runPromise(discoverLabeledContainers(api, ctx));
  expect(services).toEqual([
    {
      providerId: ProviderId.make("podman"),
      app: AppId.make("orphan"),
      appRoot: AbsolutePath.make("/tmp/deleted"),
      service: ServiceName.make("db"),
      containerId: "running-id",
      status: "running",
      publications: { status: "unknown" },
      labels: { "dev.lando.app": "orphan", "dev.lando.service": "db", "dev.lando.app-root": "/tmp/deleted" },
    },
    {
      providerId: ProviderId.make("podman"),
      app: AppId.make("orphan"),
      service: ServiceName.make("worker"),
      containerId: "stopped-id",
      status: "exited",
      publications: { status: "unknown" },
      labels: { "dev.lando.app": "orphan", "dev.lando.service": "worker" },
    },
  ]);
  expect(calls[0]?.method).toBe("GET");
  const query = new URLSearchParams(calls[0]?.path.split("?")[1]);
  expect(query.get("all")).toBe("true");
  expect(JSON.parse(query.get("filters") ?? "{}")).toEqual({ label: ["dev.lando.app"] });
});

test.each([
  { status: 500, body: '{"message":"runtime unavailable"}', tag: "ProviderUnavailableError" },
  { status: 200, body: "invalid-json", tag: "ProviderInternalError" },
])("returns a tagged discovery failure for $tag", async ({ status, body, tag }) => {
  const api: EngineHttpApi = { request: () => Effect.succeed({ status, body }) };
  const result = await Effect.runPromiseExit(discoverLabeledContainers(api, ctx));
  expect(String(result)).toContain(tag);
});

test("a container's app-root label overrides the planned root for the same container id", () => {
  const observed = (containerId: string, appRoot: string) => ({
    providerId: ProviderId.make("lando"),
    app: AppId.make("app"),
    appRoot: AbsolutePath.make(appRoot),
    service: ServiceName.make("web"),
    containerId,
    status: "running" as const,
    publications: { status: "unknown" as const },
    labels: { "dev.lando.app": "app", "dev.lando.app-root": appRoot, "dev.lando.service": "web" },
  });

  const result = labelOwnedSnapshots(
    [observed("recreated", "/plan-root"), observed("unchanged", "/plan-root")],
    [observed("recreated", "/deleted-root"), observed("unrelated", "/other")],
  );

  expect(result.map((snapshot) => [snapshot.containerId, snapshot.appRoot])).toEqual([
    ["recreated", "/deleted-root"],
    ["unchanged", "/plan-root"],
  ]);
});

test("reports the listing provider id and keeps a conflicting provider label", async () => {
  // Given a container that another provider's label claims, listed through this provider.
  const api: EngineHttpApi = {
    request: () =>
      Effect.succeed({
        status: 200,
        body: JSON.stringify([
          {
            Id: "claimed-by-docker",
            State: "running",
            Labels: {
              "dev.lando.app": "orphan",
              "dev.lando.app-root": "/tmp/deleted",
              "dev.lando.service": "db",
              "dev.lando.provider": "docker",
            },
          },
        ]),
      }),
  };
  // When
  const services = await Effect.runPromise(discoverLabeledContainers(api, ctx));
  // Then discovery never rewrites the reporting provider, so the ownership predicate can reject it.
  expect(services).toEqual([
    {
      providerId: ProviderId.make("podman"),
      app: AppId.make("orphan"),
      appRoot: AbsolutePath.make("/tmp/deleted"),
      service: ServiceName.make("db"),
      containerId: "claimed-by-docker",
      status: "running",
      publications: { status: "unknown" },
      labels: {
        "dev.lando.app": "orphan",
        "dev.lando.app-root": "/tmp/deleted",
        "dev.lando.service": "db",
        "dev.lando.provider": "docker",
      },
    },
  ]);
});

test("a contradictory discovered container cannot override the planned root", () => {
  // Given a container whose own provider label contradicts the provider listing it.
  const planned = {
    providerId: ProviderId.make("lando"),
    app: AppId.make("app"),
    appRoot: AbsolutePath.make("/plan-root"),
    service: ServiceName.make("web"),
    containerId: "recreated",
    status: "running" as const,
    publications: { status: "unknown" as const },
  };
  const contradictory = {
    ...planned,
    appRoot: AbsolutePath.make("/deleted-root"),
    labels: {
      "dev.lando.app": "app",
      "dev.lando.app-root": "/deleted-root",
      "dev.lando.service": "web",
      "dev.lando.provider": "docker",
    },
  };
  // When
  const result = labelOwnedSnapshots([planned], [contradictory]);
  // Then the incoherent label set cannot rewrite this plan's teardown target.
  expect(result.map((snapshot) => snapshot.appRoot)).toEqual([AbsolutePath.make("/plan-root")]);
});

test.each([false, true])("merges label-owned containers with includeScratch=%s", (includeScratch) => {
  const planned = {
    providerId: ProviderId.make("podman"),
    app: AppId.make("app"),
    appRoot: AbsolutePath.make("/plan-root"),
    service: ServiceName.make("web"),
    containerId: "planned",
    status: "running" as const,
    publications: { status: "unknown" as const },
  };
  const labeled = {
    ...planned,
    appRoot: AbsolutePath.make("/label-root"),
    labels: { "dev.lando.app": "app", "dev.lando.app-root": "/label-root", "dev.lando.service": "web" },
  };
  const unplanned = { ...planned, containerId: "unplanned" };
  const scratch = { ...planned, containerId: "scratch", labels: { "dev.lando.scratch": "TRUE" } };

  const result = mergeDiscoveredContainers([planned], [labeled, unplanned, scratch], includeScratch);

  const relabeled = { ...planned, appRoot: AbsolutePath.make("/label-root") };
  expect(result).toEqual(includeScratch ? [relabeled, unplanned, scratch] : [relabeled, unplanned]);
});
