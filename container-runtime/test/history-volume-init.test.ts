import { expect, test } from "bun:test";
import { DateTime, Effect } from "effect";

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

test("bringUp runs the history init helper against the history volume", async () => {
  const calls: Array<{ readonly method: string; readonly path: string; readonly body?: unknown }> = [];
  await Effect.runPromise(
    bringUp(historyPlan(), {
      ctx: { providerId: "podman", remediation: "test" },
      api: {
        request: (request) => {
          calls.push({ method: request.method, path: request.path, body: request.body });
          if (request.path.startsWith("/containers/create")) {
            return Effect.succeed({ status: 201, body: '{"Id":"helper"}' });
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
  const volumeCreate = calls.find((call) => call.path === "/volumes/create");
  const volumeBody = volumeCreate?.body as {
    Name?: string;
    Labels?: Readonly<Record<string, string>>;
  };
  expect(volumeBody.Name).toBe(historyStore);
  expect(volumeBody.Labels?.[STORAGE_SCOPE_LABEL]).toBe("app");

  const create = calls.find((call) => call.path.startsWith("/containers/create"));
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
