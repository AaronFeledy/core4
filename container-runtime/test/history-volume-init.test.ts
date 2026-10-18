import { expect, test } from "bun:test";
import { DateTime, Effect } from "effect";

import type { ProviderUnavailableError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  HISTORY_MOUNT_TARGET,
  PortablePath,
  ProviderId,
  ServiceName,
} from "@lando/sdk/schema";

import { STORAGE_SCOPE_LABEL } from "../src/labels.ts";
import { inspectMountDestinations } from "../src/podman/bring-up-recreate.ts";
import { bringUp, historyStoreNamesFromPlan } from "../src/podman/bring-up.ts";
import { VOLUME_HISTORY_IMAGE, volumeHistoryInitCommand } from "../src/volume-history-helper.ts";

const historyStore = "lando-histapp-history";
const providerId = ProviderId.make("podman");
const serviceName = ServiceName.make("web");
const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-09-01T00:00:00Z"),
  source: "test",
  runtime: 4 as const,
};

const historyPlan = (): AppPlan =>
  ({
    id: AppId.make("histapp"),
    name: "histapp",
    slug: "histapp",
    root: AbsolutePath.make("/owner"),
    provider: providerId,
    identity: { appRoot: AbsolutePath.make("/owner"), ownerKey: "owner" },
    services: {
      [serviceName]: {
        name: serviceName,
        type: "php:8.3",
        provider: providerId,
        primary: true,
        artifact: { kind: "ref" as const, ref: "php:8.3-apache" },
        environment: {},
        mounts: [],
        storage: [{ store: historyStore, target: PortablePath.make(HISTORY_MOUNT_TARGET), readOnly: false }],
        endpoints: [],
        routes: [],
        dependsOn: [],
        hostAliases: [],
        metadata,
        extensions: {},
      },
    },
    routes: [],
    networks: [],
    stores: [{ name: historyStore, scope: "app" as const, kind: "data" as const }],
    fileSync: [],
    metadata,
    extensions: {},
  }) as AppPlan;

interface CapturedCall {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
}

const echoCreatedVolume = (body: unknown) => {
  const request = body as { Name?: string; Labels?: Readonly<Record<string, string>> };
  return {
    status: 201,
    body: JSON.stringify({ Name: request.Name, Labels: request.Labels ?? {} }),
  };
};

const isHistoryHelperCreate = (call: CapturedCall): boolean => {
  if (!call.path.startsWith("/containers/create")) return false;
  const body = call.body as { Image?: string } | undefined;
  return body?.Image === VOLUME_HISTORY_IMAGE;
};

const recordingBringUp = async (input: {
  readonly volumeStatus?: number;
  readonly imageStatus?: number;
  readonly helperCreateStatus?: number;
  readonly ensureImage?: (ref: string) => Effect.Effect<void, ProviderUnavailableError>;
  readonly warnings?: string[];
}) => {
  const calls: CapturedCall[] = [];
  const warnings = input.warnings;
  await Effect.runPromise(
    bringUp(historyPlan(), {
      ctx: { providerId: "podman", remediation: "test" },
      ...(input.ensureImage === undefined
        ? {}
        : {
            ensureImage: ({ ref }: { readonly ref: string }) => input.ensureImage?.(ref) ?? Effect.void,
          }),
      ...(warnings === undefined
        ? {}
        : {
            eventService: {
              publish: (event: { readonly _tag: string; readonly body?: string }) =>
                Effect.sync(() => {
                  if (event._tag === "message.warn" && event.body !== undefined) warnings.push(event.body);
                }),
            },
          }),
      api: {
        request: (request) => {
          calls.push({ method: request.method, path: request.path, body: request.body });
          if (request.path === "/volumes/create") {
            if ((input.volumeStatus ?? 201) === 409) return Effect.succeed({ status: 409, body: "{}" });
            return Effect.succeed(echoCreatedVolume(request.body));
          }
          if (request.path === `/images/${encodeURIComponent(VOLUME_HISTORY_IMAGE)}/json`) {
            return Effect.succeed({ status: input.imageStatus ?? 200, body: "{}" });
          }
          if (request.path.startsWith("/containers/create")) {
            const body = request.body as { Image?: string };
            if (body.Image === VOLUME_HISTORY_IMAGE) {
              return Effect.succeed({
                status: input.helperCreateStatus ?? 201,
                body: '{"Id":"helper"}',
              });
            }
            return Effect.succeed({ status: 201, body: '{"Id":"web"}' });
          }
          if (request.path.endsWith("/start")) {
            return Effect.succeed({ status: 204, body: "" });
          }
          if (request.path.includes("/wait")) {
            return Effect.succeed({ status: 200, body: '{"StatusCode":0}' });
          }
          if (request.path.endsWith("/json")) {
            return Effect.succeed({
              status: 200,
              body: JSON.stringify({ State: { Running: true, Status: "running" } }),
            });
          }
          return Effect.succeed({ status: 200, body: "{}" });
        },
      },
    }),
  );
  return calls;
};

test("historyStoreNamesFromPlan reads the history mount target", () => {
  expect(historyStoreNamesFromPlan(historyPlan())).toEqual([historyStore]);
});

test("inspectMountDestinations reads container mount destinations", () => {
  expect(inspectMountDestinations({ Mounts: [{ Destination: HISTORY_MOUNT_TARGET }] })).toEqual([
    HISTORY_MOUNT_TARGET,
  ]);
  expect(inspectMountDestinations({ Mounts: [{ Destination: "/app" }] })).toEqual(["/app"]);
  expect(inspectMountDestinations({})).toBeUndefined();
});

test("bringUp inits a newly created history volume after ensuring the helper image", async () => {
  const ensured: string[] = [];
  const calls = await recordingBringUp({
    ensureImage: (ref) =>
      Effect.sync(() => {
        ensured.push(ref);
      }),
  });
  expect(ensured).toEqual([VOLUME_HISTORY_IMAGE]);
  expect(calls.some((call) => call.path === `/images/${encodeURIComponent(VOLUME_HISTORY_IMAGE)}/json`)).toBe(
    false,
  );

  const volumeCreate = calls.find((call) => call.path === "/volumes/create");
  const volumeBody = volumeCreate?.body as {
    Name?: string;
    Labels?: Readonly<Record<string, string>>;
  };
  expect(volumeBody.Name).toBe(historyStore);
  expect(volumeBody.Labels?.[STORAGE_SCOPE_LABEL]).toBe("app");

  const create = calls.find(isHistoryHelperCreate);
  expect(create).toBeDefined();
  const body = create?.body as {
    Image?: string;
    User?: string;
    Cmd?: readonly string[];
    HostConfig?: { Binds?: string[]; NetworkMode?: string };
  };
  expect(body.Image).toBe(VOLUME_HISTORY_IMAGE);
  expect(body.User).toBe("0:0");
  expect(body.Cmd).toEqual([...volumeHistoryInitCommand()]);
  expect(body.HostConfig?.Binds).toEqual([`${historyStore}:/lando-data`]);
  expect(body.HostConfig?.NetworkMode).toBe("none");
});

test("bringUp skips history init when the volume already exists", async () => {
  const ensured: string[] = [];
  const calls = await recordingBringUp({
    volumeStatus: 409,
    ensureImage: (ref) =>
      Effect.sync(() => {
        ensured.push(ref);
      }),
  });
  expect(ensured).toEqual([]);
  expect(calls.some(isHistoryHelperCreate)).toBe(false);
});

test("missing helper image warns and does not fail bring-up", async () => {
  const warnings: string[] = [];
  const calls = await recordingBringUp({ imageStatus: 404, warnings });
  expect(calls.some(isHistoryHelperCreate)).toBe(false);
  expect(warnings.some((message) => message.includes(VOLUME_HISTORY_IMAGE))).toBe(true);
});

test("history helper failure warns and does not fail bring-up", async () => {
  const warnings: string[] = [];
  const calls = await recordingBringUp({ helperCreateStatus: 500, warnings });
  expect(calls.some(isHistoryHelperCreate)).toBe(true);
  expect(warnings.some((message) => message.includes("history volume init create failed"))).toBe(true);
});
