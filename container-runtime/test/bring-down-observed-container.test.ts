import { describe, expect, test } from "bun:test";
import { AbsolutePath, AppId, ProviderId, ServiceName } from "@lando/sdk/schema";
import type { ServiceRuntimeFields, ServiceRuntimeInfo } from "@lando/sdk/services";
import { Effect } from "effect";

import type { EngineHttpApi, EngineHttpRequest, EngineHttpResponse } from "../src/engine-api.ts";
import type { VolumeSelectorClass } from "../src/podman/volume-prune.ts";
import { bringDownObservedContainer } from "../src/service-lifecycle.ts";
import {
  type TeardownVolumeSelection,
  isGlobalScopedVolume,
  teardownVolumeClasses,
  volumeClassFromLabels,
} from "../src/volume-classes.ts";

const ctx = { providerId: "podman", remediation: "Repair podman and retry.", env: {} } as const;

const ownedLabels = {
  "dev.lando.app": "orphan-app",
  "dev.lando.app-root": "/tmp/orphan-app",
  "dev.lando.service": "database",
} as const;

const observed = (
  overrides: Partial<Omit<ServiceRuntimeFields, "containerId">> & {
    readonly withoutContainer?: true;
  } = {},
): ServiceRuntimeInfo => {
  const { withoutContainer, ...rest } = overrides;
  return {
    app: AppId.make("orphan-app"),
    appRoot: AbsolutePath.make("/tmp/orphan-app"),
    service: ServiceName.make("database"),
    providerId: ProviderId.make("podman"),
    status: "running",
    publications: { status: "unknown" },
    labels: ownedLabels,
    ...(withoutContainer === true ? {} : { containerId: "abc123" }),
    ...rest,
  };
};

const recordingApi = (
  responses: ReadonlyArray<EngineHttpResponse>,
): { readonly api: EngineHttpApi; readonly calls: EngineHttpRequest[] } => {
  const calls: EngineHttpRequest[] = [];
  const api: EngineHttpApi = {
    request: (request) =>
      Effect.sync(() => {
        calls.push(request);
        return responses[calls.length - 1] ?? { status: 204, body: "" };
      }),
  };
  return { api, calls };
};

const live = (labels: Readonly<Record<string, string>> = ownedLabels): EngineHttpResponse => ({
  status: 200,
  body: JSON.stringify({ Id: "abc123", Name: "/orphan-app-database", Config: { Labels: labels } }),
});

const requests = (calls: readonly EngineHttpRequest[]) => calls.map((call) => `${call.method} ${call.path}`);

describe("bringDownObservedContainer", () => {
  test("remove proves live ownership, stops, then force-removes the observed container id", async () => {
    const { api, calls } = recordingApi([
      live(),
      { status: 204, body: "" },
      { status: 200, body: '{"State":{"Status":"exited","ExitCode":143}}' },
      { status: 204, body: "" },
    ]);

    const removed = await Effect.runPromise(bringDownObservedContainer(observed(), "remove", { api, ctx }));

    expect(removed).toMatchObject({
      service: "database",
      containerId: "abc123",
      action: "removed",
      shutdownObservations: [{ containerId: "abc123", status: "exited", exitCode: 143 }],
    });
    expect(requests(calls)).toEqual([
      "GET /containers/abc123/json",
      "POST /containers/abc123/stop",
      "GET /containers/abc123/json",
      "DELETE /containers/abc123?force=true&v=true",
    ]);
  });

  test("stop keeps the container", async () => {
    const { api, calls } = recordingApi([
      live(),
      { status: 204, body: "" },
      { status: 200, body: '{"State":{"Status":"exited","ExitCode":0}}' },
    ]);

    const stopped = await Effect.runPromise(bringDownObservedContainer(observed(), "stop", { api, ctx }));

    expect(stopped).toMatchObject({ containerId: "abc123", action: "stopped" });
    expect(requests(calls)).toEqual([
      "GET /containers/abc123/json",
      "POST /containers/abc123/stop",
      "GET /containers/abc123/json",
    ]);
  });

  test("stop reports an already stopped container", async () => {
    const { api } = recordingApi([live(), { status: 304, body: "" }, { status: 200, body: "{}" }]);

    expect(
      await Effect.runPromise(bringDownObservedContainer(observed(), "stop", { api, ctx })),
    ).toMatchObject({ action: "already-stopped" });
  });

  test("treats an already stopped container as removable", async () => {
    const { api } = recordingApi([
      live(),
      { status: 304, body: "" },
      { status: 200, body: "{}" },
      { status: 200, body: "" },
    ]);

    expect(
      await Effect.runPromise(bringDownObservedContainer(observed(), "remove", { api, ctx })),
    ).toMatchObject({ action: "removed" });
  });

  test.each(["stop", "remove"] as const)(
    "%s reports a container that is already gone as absent",
    async (containers) => {
      const { api, calls } = recordingApi([{ status: 404, body: "" }]);

      expect(
        await Effect.runPromise(bringDownObservedContainer(observed(), containers, { api, ctx })),
      ).toMatchObject({ action: "absent" });
      expect(calls).toHaveLength(1);
    },
  );

  test("reports absence when the container disappears between stop and removal", async () => {
    // Given
    const { api, calls } = recordingApi([
      live(),
      { status: 204, body: "" },
      { status: 200, body: "{}" },
      { status: 404, body: "" },
    ]);
    // When
    const removed = await Effect.runPromise(bringDownObservedContainer(observed(), "remove", { api, ctx }));
    // Then
    expect(removed).toMatchObject({ action: "absent" });
    expect(calls[3]).toEqual({ method: "DELETE", path: "/containers/abc123?force=true&v=true" });
  });

  test("never calls the engine for an observation with no container id", async () => {
    const { api, calls } = recordingApi([]);

    const removed = await Effect.runPromise(
      bringDownObservedContainer(observed({ withoutContainer: true }), "remove", { api, ctx }),
    );

    expect(removed).toMatchObject({ action: "absent" });
    expect(calls).toEqual([]);
  });

  test("refuses an observation another provider reported", async () => {
    const { api, calls } = recordingApi([]);

    const exit = await Effect.runPromiseExit(
      bringDownObservedContainer(observed({ providerId: ProviderId.make("docker") }), "stop", { api, ctx }),
    );

    expect(exit._tag).toBe("Failure");
    expect(calls).toEqual([]);
  });

  test("fails when the engine rejects the removal", async () => {
    const { api } = recordingApi([
      live(),
      { status: 204, body: "" },
      { status: 200, body: "{}" },
      { status: 500, body: "boom" },
    ]);

    const exit = await Effect.runPromiseExit(bringDownObservedContainer(observed(), "remove", { api, ctx }));

    expect(exit._tag).toBe("Failure");
  });

  test("fails when the live container cannot be inspected", async () => {
    const { api, calls } = recordingApi([{ status: 500, body: "boom" }]);

    const exit = await Effect.runPromiseExit(bringDownObservedContainer(observed(), "stop", { api, ctx }));

    expect(exit._tag).toBe("Failure");
    expect(calls).toHaveLength(1);
  });

  test("fails when no engine api is configured", async () => {
    const exit = await Effect.runPromiseExit(bringDownObservedContainer(observed(), "remove", { ctx }));

    expect(exit._tag).toBe("Failure");
  });

  test("refuses a peer data root before stopping anything", async () => {
    const { api, calls } = recordingApi([live({ ...ownedLabels, "dev.lando.data-root": "/peer-data" })]);

    const exit = await Effect.runPromiseExit(
      bringDownObservedContainer(observed(), "stop", { api, ctx, dataRoot: "/local-data" }),
    );

    expect(exit).toMatchObject({
      _tag: "Failure",
      cause: { reasons: [{ error: { details: { label: "dev.lando.data-root" } } }] },
    });
    expect(requests(calls)).toEqual(["GET /containers/abc123/json"]);
  });
});

describe("bringDownObservedContainer ownership authorization", () => {
  test.each([
    { name: "an unlabeled container", labels: {} },
    { name: "a contradictory app label", labels: { ...ownedLabels, "dev.lando.app": "other" } },
    { name: "a contradictory root label", labels: { ...ownedLabels, "dev.lando.app-root": "/tmp/other" } },
    { name: "a contradictory service label", labels: { ...ownedLabels, "dev.lando.service": "other" } },
    { name: "a conflicting provider label", labels: { ...ownedLabels, "dev.lando.provider": "docker" } },
    { name: "a conflicting owner label", labels: { ...ownedLabels, "dev.lando.owner": "other-owner" } },
    { name: "a role helper label", labels: { ...ownedLabels, "dev.lando.role": "data-helper" } },
    { name: "an incoherent scratch marker", labels: { ...ownedLabels, "dev.lando.scratch": "TRUE" } },
    {
      name: "a scratch id owned by another app",
      labels: { ...ownedLabels, "dev.lando.scratch": "TRUE", "dev.lando.scratch-id": "other" },
    },
  ])("refuses $name on the live container before stopping it", async ({ labels }) => {
    for (const containers of ["stop", "remove"] as const) {
      const { api, calls } = recordingApi([live(labels)]);

      const exit = await Effect.runPromiseExit(
        bringDownObservedContainer(observed(), containers, { api, ctx }),
      );

      expect(exit._tag).toBe("Failure");
      expect(requests(calls)).toEqual(["GET /containers/abc123/json"]);
    }
  });

  test("authorizes from the live labels, never the labels the observation carries", async () => {
    // Given: the observation claims ownership, but the container itself belongs to another root.
    const { api, calls } = recordingApi([live({ ...ownedLabels, "dev.lando.app-root": "/tmp/other" })]);

    // When
    const exit = await Effect.runPromiseExit(bringDownObservedContainer(observed(), "remove", { api, ctx }));

    // Then
    expect(exit._tag).toBe("Failure");
    expect(requests(calls)).toEqual(["GET /containers/abc123/json"]);
  });

  test("refusal names the container id and the disagreeing label", async () => {
    const { api, calls } = recordingApi([live({ ...ownedLabels, "dev.lando.provider": "docker" })]);

    const result = await Effect.runPromise(
      bringDownObservedContainer(observed(), "remove", { api, ctx }).pipe(Effect.result),
    );

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "ProviderUnavailableError",
        operation: "bringDownObserved",
        details: { containerId: "abc123", label: "dev.lando.provider" },
      },
    });
    if (result._tag === "Failure") expect(result.failure.remediation).toContain("abc123");
    expect(calls).toHaveLength(1);
  });
});

describe("teardown volume classes", () => {
  test.each([
    [{}, ["data"]],
    [{ volumes: true }, ["data"]],
    [{ purgeCaches: true }, ["cache"]],
    [{ volumes: true, purgeCaches: true }, ["cache", "data"]],
  ] as ReadonlyArray<readonly [TeardownVolumeSelection, ReadonlyArray<VolumeSelectorClass>]>)(
    "selects %o -> %o",
    (selection, expected) => {
      expect(teardownVolumeClasses(selection)).toEqual(expected);
    },
  );

  test("reads the class a provider wrote onto the volume", () => {
    expect(volumeClassFromLabels({ "dev.lando.storage-kind": "cache" })).toBe("cache");
    expect(volumeClassFromLabels({ "dev.lando.store": "database" })).toBe("data");
    expect(volumeClassFromLabels(undefined)).toBe("data");
  });

  test("recognizes a globally scoped volume", () => {
    expect(isGlobalScopedVolume({ "dev.lando.scope": "global" })).toBe(true);
    expect(isGlobalScopedVolume({ "dev.lando.scope": "app" })).toBe(false);
    expect(isGlobalScopedVolume(undefined)).toBe(false);
  });
});
