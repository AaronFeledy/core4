import { expect, test } from "bun:test";
import { DateTime, Effect } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  HISTORY_MOUNT_TARGET,
  PortablePath,
  ProviderId,
  ServiceName,
} from "@lando/sdk/schema";

import { STORAGE_SCOPE_LABEL, VOLUME_INSTANCE_LABEL } from "../src/labels.ts";
import { inspectMountDestinations } from "../src/podman/bring-up-recreate.ts";
import { bringUp, historyStoreNamesFromPlan } from "../src/podman/bring-up.ts";
import {
  HISTORY_MODE_INSTANCE_LABEL,
  HISTORY_MODE_LABEL,
  HISTORY_MODE_VERIFIED,
  VOLUME_HISTORY_IMAGE,
  historyModeMarkerName,
  volumeHistoryInitCommand,
  volumeHistoryModeCheckCommand,
} from "../src/volume-history-helper.ts";

const historyStore = "lando-histapp-history";
const historyMarker = historyModeMarkerName(historyStore);
const storeInstanceId = "store-instance-1";
const staleInstanceId = "stale-instance";
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
        extensions: { compose: { platform: "linux/arm64" } },
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

interface EnsureImageCall {
  readonly ref: string;
  readonly force: boolean;
  readonly extensions: ServicePlanExtensions;
}

type ServicePlanExtensions = AppPlan["services"][typeof serviceName]["extensions"];

const echoCreatedVolume = (body: unknown) => {
  const request = body as { Name?: string; Labels?: Readonly<Record<string, string>> };
  return {
    status: 201,
    body: JSON.stringify({ Name: request.Name, Labels: request.Labels ?? {} }),
  };
};

const helperCmd = (call: CapturedCall): readonly string[] | undefined => {
  const body = call.body as { Cmd?: readonly string[] } | undefined;
  return body?.Cmd;
};

const cmdsEqual = (left: readonly string[] | undefined, right: readonly string[]): boolean =>
  left !== undefined && left.length === right.length && left.every((value, index) => value === right[index]);

const isHistoryHelperCreate = (call: CapturedCall): boolean => {
  if (!call.path.startsWith("/containers/create")) return false;
  const body = call.body as { Image?: string } | undefined;
  return body?.Image === VOLUME_HISTORY_IMAGE;
};

const isHistoryInitCreate = (call: CapturedCall): boolean =>
  isHistoryHelperCreate(call) && cmdsEqual(helperCmd(call), volumeHistoryInitCommand());

const isHistoryModeCheckCreate = (call: CapturedCall): boolean =>
  isHistoryHelperCreate(call) && cmdsEqual(helperCmd(call), volumeHistoryModeCheckCommand());

const recordingBringUp = async (input: {
  readonly volumeStatus?: number;
  readonly imageStatus?: number;
  readonly helperCreateStatus?: number;
  readonly initWaitStatus?: number;
  readonly initWaitBody?: string;
  readonly modeCheckWaitStatus?: number;
  readonly modeCheckWaitBody?: string;
  readonly verifiedMarker?: boolean;
  readonly staleMarker?: boolean;
  readonly storeInstanceId?: string | false;
  readonly markerCreateStatus?: number;
  readonly providerId?: "podman" | "docker";
  readonly ensureImage?: (input: {
    readonly service: { readonly extensions: ServicePlanExtensions };
    readonly ref: string;
    readonly force: boolean;
  }) => Effect.Effect<void, ProviderUnavailableError>;
  readonly warnings?: string[];
}) => {
  const calls: CapturedCall[] = [];
  const warnings = input.warnings;
  let lastHelperWasModeCheck = false;
  let markerExists = input.verifiedMarker === true || input.staleMarker === true;
  let firstMarkerCreate = true;
  const existingStore = (input.volumeStatus ?? 201) === 409;
  const storeInstance =
    input.storeInstanceId === false ? undefined : (input.storeInstanceId ?? storeInstanceId);
  const markerPath = `/volumes/${encodeURIComponent(historyMarker)}`;
  const storePath = `/volumes/${encodeURIComponent(historyStore)}`;
  const plan = historyPlan();
  const ctxProvider = input.providerId ?? "podman";
  await Effect.runPromise(
    bringUp(ctxProvider === "podman" ? plan : { ...plan, provider: ProviderId.make("docker") }, {
      ctx: { providerId: ctxProvider, remediation: "test" },
      ...(input.ensureImage === undefined
        ? {}
        : {
            ensureImage: (request: {
              readonly service: { readonly extensions: ServicePlanExtensions };
              readonly ref: string;
              readonly force: boolean;
            }) => input.ensureImage?.(request) ?? Effect.void,
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
            const name = (request.body as { Name?: string } | undefined)?.Name;
            if (name === historyStore && existingStore) {
              return Effect.succeed({ status: 409, body: "{}" });
            }
            if (name === historyMarker) {
              const forceFirstConflict = input.markerCreateStatus === 409 && firstMarkerCreate;
              firstMarkerCreate = false;
              if (markerExists || forceFirstConflict) {
                return Effect.succeed({ status: 409, body: "{}" });
              }
              markerExists = true;
            }
            return Effect.succeed(echoCreatedVolume(request.body));
          }
          if (request.method === "DELETE" && request.path.startsWith(`${markerPath}`)) {
            markerExists = false;
            return Effect.succeed({ status: 204, body: "" });
          }
          if (request.method === "GET" && request.path === markerPath) {
            if (!markerExists) return Effect.succeed({ status: 404, body: "{}" });
            const instance = input.staleMarker === true ? staleInstanceId : storeInstance;
            return Effect.succeed({
              status: 200,
              body: JSON.stringify({
                Name: historyMarker,
                Labels: {
                  [HISTORY_MODE_LABEL]: HISTORY_MODE_VERIFIED,
                  ...(instance === undefined ? {} : { [HISTORY_MODE_INSTANCE_LABEL]: instance }),
                },
              }),
            });
          }
          if (request.method === "GET" && request.path === storePath) {
            if (!existingStore) return Effect.succeed({ status: 404, body: "{}" });
            return Effect.succeed({
              status: 200,
              body: JSON.stringify({
                Name: historyStore,
                Labels: storeInstance === undefined ? {} : { [VOLUME_INSTANCE_LABEL]: storeInstance },
              }),
            });
          }
          if (request.method === "GET" && request.path.startsWith("/volumes/")) {
            return Effect.succeed({ status: 404, body: "{}" });
          }
          if (request.path === `/images/${encodeURIComponent(VOLUME_HISTORY_IMAGE)}/json`) {
            return Effect.succeed({ status: input.imageStatus ?? 200, body: "{}" });
          }
          if (request.path.startsWith("/containers/create")) {
            const body = request.body as { Image?: string; Cmd?: readonly string[] };
            if (body.Image === VOLUME_HISTORY_IMAGE) {
              lastHelperWasModeCheck = cmdsEqual(body.Cmd, volumeHistoryModeCheckCommand());
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
            if (lastHelperWasModeCheck && input.modeCheckWaitBody !== undefined) {
              return Effect.succeed({ status: 200, body: input.modeCheckWaitBody });
            }
            if (!lastHelperWasModeCheck && input.initWaitBody !== undefined) {
              return Effect.succeed({ status: 200, body: input.initWaitBody });
            }
            const statusCode = lastHelperWasModeCheck
              ? (input.modeCheckWaitStatus ?? 0)
              : (input.initWaitStatus ?? 0);
            return Effect.succeed({ status: 200, body: JSON.stringify({ StatusCode: statusCode }) });
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

const markerCreate = (calls: readonly CapturedCall[]) =>
  calls.find(
    (call) =>
      call.path === "/volumes/create" && (call.body as { Name?: string } | undefined)?.Name === historyMarker,
  );

const markerCreateLabels = (calls: readonly CapturedCall[]) =>
  (markerCreate(calls)?.body as { Labels?: Readonly<Record<string, string>> } | undefined)?.Labels;

const markerDeleted = (calls: readonly CapturedCall[]) =>
  calls.some(
    (call) =>
      call.method === "DELETE" && call.path.startsWith(`/volumes/${encodeURIComponent(historyMarker)}`),
  );

const storeCreateInstance = (calls: readonly CapturedCall[]) =>
  (
    calls.find(
      (call) =>
        call.path === "/volumes/create" &&
        (call.body as { Name?: string } | undefined)?.Name === historyStore,
    )?.body as { Labels?: Readonly<Record<string, string>> } | undefined
  )?.Labels?.[VOLUME_INSTANCE_LABEL];

const succeedingEnsureImage = (ensured: EnsureImageCall[]) => ({
  ensureImage: (request: {
    readonly service: { readonly extensions: ServicePlanExtensions };
    readonly ref: string;
    readonly force: boolean;
  }) =>
    Effect.sync(() => {
      ensured.push({ ref: request.ref, force: request.force, extensions: request.service.extensions });
    }),
});

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
  const ensured: EnsureImageCall[] = [];
  const calls = await recordingBringUp(succeedingEnsureImage(ensured));
  expect(ensured).toEqual([{ ref: VOLUME_HISTORY_IMAGE, force: false, extensions: {} }]);
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

  expect(calls.some(isHistoryModeCheckCreate)).toBe(false);
  const create = calls.find(isHistoryInitCreate);
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
  expect(markerCreateLabels(calls)?.[HISTORY_MODE_LABEL]).toBe(HISTORY_MODE_VERIFIED);
  expect(markerCreateLabels(calls)?.[HISTORY_MODE_INSTANCE_LABEL]).toBe(storeCreateInstance(calls));
});

test("bringUp skips history chmod when the existing volume root is already 1777", async () => {
  const ensured: EnsureImageCall[] = [];
  const calls = await recordingBringUp({
    volumeStatus: 409,
    modeCheckWaitStatus: 0,
    ...succeedingEnsureImage(ensured),
  });
  expect(ensured).toEqual([{ ref: VOLUME_HISTORY_IMAGE, force: false, extensions: {} }]);
  expect(calls.some(isHistoryModeCheckCreate)).toBe(true);
  expect(calls.some(isHistoryInitCreate)).toBe(false);
  expect(markerCreateLabels(calls)?.[HISTORY_MODE_LABEL]).toBe(HISTORY_MODE_VERIFIED);
  expect(markerCreateLabels(calls)?.[HISTORY_MODE_INSTANCE_LABEL]).toBe(storeInstanceId);
});

test.each(["podman", "docker"] as const)(
  "bringUp skips helper image and container when history mode is already verified (%s)",
  async (provider) => {
    const ensured: EnsureImageCall[] = [];
    const warnings: string[] = [];
    const calls = await recordingBringUp({
      volumeStatus: 409,
      verifiedMarker: true,
      providerId: provider,
      warnings,
      ...succeedingEnsureImage(ensured),
    });
    expect(ensured).toEqual([]);
    expect(calls.some(isHistoryHelperCreate)).toBe(false);
    expect(markerDeleted(calls)).toBe(false);
    expect(markerCreate(calls)).toBeUndefined();
    expect(warnings).toEqual([]);
  },
);

test("missing helper image warns and does not fail bring-up", async () => {
  const warnings: string[] = [];
  const calls = await recordingBringUp({ imageStatus: 404, warnings });
  expect(calls.some(isHistoryHelperCreate)).toBe(false);
  expect(warnings.some((message) => message.includes(VOLUME_HISTORY_IMAGE))).toBe(true);
  expect(warnings.some((message) => message.includes("until the next rebuild"))).toBe(false);
  expect(warnings.some((message) => message.includes("later start initializes the volume"))).toBe(true);
});

test("ensureImage failure warns and does not fail bring-up", async () => {
  const warnings: string[] = [];
  const calls = await recordingBringUp({
    warnings,
    ensureImage: () =>
      Effect.fail(
        new ProviderUnavailableError({
          providerId: "podman",
          operation: "bringUp.historyInit",
          message: `Failed to pull ${VOLUME_HISTORY_IMAGE}: offline`,
          remediation: "test",
        }),
      ),
  });
  expect(calls.some(isHistoryHelperCreate)).toBe(false);
  expect(warnings.some((message) => message.includes("offline"))).toBe(true);
  expect(warnings.some((message) => message.includes("until the next rebuild"))).toBe(false);
  expect(warnings.some((message) => message.includes("Retry start once the helper image is available"))).toBe(
    true,
  );
});

test("history helper create failure warns and does not fail bring-up", async () => {
  const warnings: string[] = [];
  const calls = await recordingBringUp({ helperCreateStatus: 500, warnings });
  expect(calls.some(isHistoryInitCreate)).toBe(true);
  expect(warnings.some((message) => message.includes("history volume init create failed"))).toBe(true);
  expect(warnings.some((message) => message.includes("until the next rebuild"))).toBe(false);
});

test("unparsed history helper wait StatusCode warns and does not fail bring-up", async () => {
  const warnings: string[] = [];
  const calls = await recordingBringUp({ initWaitBody: "{}", warnings });
  expect(calls.some(isHistoryInitCreate)).toBe(true);
  expect(warnings.some((message) => message.includes("wait returned no StatusCode"))).toBe(true);
  expect(
    calls.some(
      (call) =>
        call.path === "/volumes/create" &&
        (call.body as { Name?: string } | undefined)?.Name === historyMarker,
    ),
  ).toBe(false);
});

test("nonzero history helper exit warns and does not fail bring-up", async () => {
  const warnings: string[] = [];
  const calls = await recordingBringUp({ initWaitStatus: 1, warnings });
  expect(calls.some(isHistoryInitCreate)).toBe(true);
  expect(warnings.some((message) => message.includes("history volume init exited 1"))).toBe(true);
  expect(warnings.some((message) => message.includes("until the next rebuild"))).toBe(false);
  expect(warnings.some((message) => message.includes("Retry start, or run lando doctor"))).toBe(true);
});

test("later bring-up retries history init after a failed first one", async () => {
  const firstWarnings: string[] = [];
  const first = await recordingBringUp({
    initWaitStatus: 1,
    warnings: firstWarnings,
    ...succeedingEnsureImage([]),
  });
  expect(first.some(isHistoryInitCreate)).toBe(true);
  expect(firstWarnings.some((message) => message.includes("history volume init exited 1"))).toBe(true);

  const second = await recordingBringUp({
    volumeStatus: 409,
    modeCheckWaitStatus: 1,
    initWaitStatus: 0,
    ...succeedingEnsureImage([]),
  });
  expect(second.some(isHistoryModeCheckCreate)).toBe(true);
  expect(second.some(isHistoryInitCreate)).toBe(true);
});

test.each(["podman", "docker"] as const)(
  "bringUp replaces a stale marker when a new store is created (%s)",
  async (provider) => {
    const ensured: EnsureImageCall[] = [];
    const calls = await recordingBringUp({
      staleMarker: true,
      providerId: provider,
      ...succeedingEnsureImage(ensured),
    });
    expect(ensured).toEqual([{ ref: VOLUME_HISTORY_IMAGE, force: false, extensions: {} }]);
    expect(markerDeleted(calls)).toBe(true);
    expect(calls.some(isHistoryInitCreate)).toBe(true);
    expect(markerCreateLabels(calls)?.[HISTORY_MODE_LABEL]).toBe(HISTORY_MODE_VERIFIED);
    expect(markerCreateLabels(calls)?.[HISTORY_MODE_INSTANCE_LABEL]).toBe(storeCreateInstance(calls));
    expect(markerCreateLabels(calls)?.[HISTORY_MODE_INSTANCE_LABEL]).not.toBe(staleInstanceId);
  },
);

test.each(["podman", "docker"] as const)(
  "bringUp deletes a mismatched marker then recreates it after a successful check (%s)",
  async (provider) => {
    const calls = await recordingBringUp({
      volumeStatus: 409,
      staleMarker: true,
      modeCheckWaitStatus: 0,
      providerId: provider,
      ...succeedingEnsureImage([]),
    });
    const deleteIndex = calls.findIndex(
      (call) =>
        call.method === "DELETE" && call.path.startsWith(`/volumes/${encodeURIComponent(historyMarker)}`),
    );
    const helperIndex = calls.findIndex(isHistoryHelperCreate);
    const createIndex = calls.findIndex(
      (call) =>
        call.path === "/volumes/create" &&
        (call.body as { Name?: string } | undefined)?.Name === historyMarker,
    );
    expect(deleteIndex).toBeGreaterThanOrEqual(0);
    expect(helperIndex).toBeGreaterThan(deleteIndex);
    expect(createIndex).toBeGreaterThan(helperIndex);
    expect(calls.some(isHistoryModeCheckCreate)).toBe(true);
    expect(calls.some(isHistoryInitCreate)).toBe(false);
    expect(markerCreateLabels(calls)?.[HISTORY_MODE_INSTANCE_LABEL]).toBe(storeInstanceId);
  },
);

test("bringUp never skips or stamps when the store has no instance UUID", async () => {
  const ensured: EnsureImageCall[] = [];
  const calls = await recordingBringUp({
    volumeStatus: 409,
    verifiedMarker: true,
    storeInstanceId: false,
    modeCheckWaitStatus: 0,
    ...succeedingEnsureImage(ensured),
  });
  expect(ensured).toEqual([{ ref: VOLUME_HISTORY_IMAGE, force: false, extensions: {} }]);
  expect(calls.some(isHistoryModeCheckCreate)).toBe(true);
  expect(markerDeleted(calls)).toBe(true);
  expect(markerCreate(calls)).toBeUndefined();
});

test("unparsed history mode-check wait StatusCode fails closed and runs init", async () => {
  const warnings: string[] = [];
  const calls = await recordingBringUp({
    volumeStatus: 409,
    modeCheckWaitBody: "{}",
    initWaitStatus: 0,
    warnings,
    ...succeedingEnsureImage([]),
  });
  expect(calls.some(isHistoryModeCheckCreate)).toBe(true);
  expect(calls.some(isHistoryInitCreate)).toBe(true);
  expect(markerCreateLabels(calls)?.[HISTORY_MODE_INSTANCE_LABEL]).toBe(storeInstanceId);
  expect(warnings).toEqual([]);
});

test("bringUp deletes a 409 marker then recreates it with the current instance", async () => {
  const calls = await recordingBringUp({
    volumeStatus: 409,
    modeCheckWaitStatus: 0,
    markerCreateStatus: 409,
    ...succeedingEnsureImage([]),
  });
  const creates = calls.filter(
    (call) =>
      call.path === "/volumes/create" && (call.body as { Name?: string } | undefined)?.Name === historyMarker,
  );
  expect(creates).toHaveLength(2);
  expect(markerDeleted(calls)).toBe(true);
  expect(creates[1]?.body).toMatchObject({
    Labels: {
      [HISTORY_MODE_LABEL]: HISTORY_MODE_VERIFIED,
      [HISTORY_MODE_INSTANCE_LABEL]: storeInstanceId,
    },
  });
});
