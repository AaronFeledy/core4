import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { AppId, ProviderId, ServiceName } from "@lando/sdk/schema";
import type { ServiceRuntimeInfo } from "@lando/sdk/services";

import type { EngineHttpApi, EngineHttpRequest, EngineHttpResponse } from "../src/engine-api.ts";
import type { VolumeSelectorClass } from "../src/podman/volume-prune.ts";
import { removeObservedContainer } from "../src/service-lifecycle.ts";
import {
  type TeardownVolumeSelection,
  isGlobalScopedVolume,
  teardownVolumeClasses,
  volumeClassFromLabels,
} from "../src/volume-classes.ts";

const ctx = { providerId: "podman", remediation: "Repair podman and retry." } as const;

const observed = (
  overrides: Partial<Omit<ServiceRuntimeInfo, "containerId">> & { readonly withoutContainer?: true } = {},
): ServiceRuntimeInfo => {
  const { withoutContainer, ...rest } = overrides;
  return {
    app: AppId.make("orphan-app"),
    service: ServiceName.make("database"),
    providerId: ProviderId.make("podman"),
    status: "running",
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

describe("removeObservedContainer", () => {
  test("stops then force-removes the observed container id", async () => {
    const { api, calls } = recordingApi([
      { status: 204, body: "" },
      { status: 204, body: "" },
    ]);

    const removed = await Effect.runPromise(removeObservedContainer(observed(), { api, ctx }));

    expect(removed).toBe(true);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /containers/abc123/stop",
      "DELETE /containers/abc123?force=true",
    ]);
  });

  test("treats an already stopped container as removable", async () => {
    const { api } = recordingApi([
      { status: 304, body: "" },
      { status: 200, body: "" },
    ]);

    expect(await Effect.runPromise(removeObservedContainer(observed(), { api, ctx }))).toBe(true);
  });

  test("reports a container that is already gone as not removed", async () => {
    const { api, calls } = recordingApi([{ status: 404, body: "" }]);

    expect(await Effect.runPromise(removeObservedContainer(observed(), { api, ctx }))).toBe(false);
    expect(calls).toHaveLength(1);
  });

  test("never calls the engine for an observation with no container id", async () => {
    const { api, calls } = recordingApi([]);

    const removed = await Effect.runPromise(
      removeObservedContainer(observed({ withoutContainer: true }), { api, ctx }),
    );

    expect(removed).toBe(false);
    expect(calls).toEqual([]);
  });

  test("refuses an observation another provider reported", async () => {
    const { api, calls } = recordingApi([]);

    const exit = await Effect.runPromiseExit(
      removeObservedContainer(observed({ providerId: ProviderId.make("docker") }), { api, ctx }),
    );

    expect(exit._tag).toBe("Failure");
    expect(calls).toEqual([]);
  });

  test("fails when the engine rejects the removal", async () => {
    const { api } = recordingApi([
      { status: 204, body: "" },
      { status: 500, body: "boom" },
    ]);

    const exit = await Effect.runPromiseExit(removeObservedContainer(observed(), { api, ctx }));

    expect(exit._tag).toBe("Failure");
  });

  test("fails when no engine api is configured", async () => {
    const exit = await Effect.runPromiseExit(removeObservedContainer(observed(), { ctx }));

    expect(exit._tag).toBe("Failure");
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
