import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeAppliedPlanCache } from "@lando/container-runtime/applied-plan-cache";
import { makeAppliedPlanStore } from "@lando/container-runtime/applied-state";
import type { EngineHttpRequest } from "@lando/container-runtime/engine-api";
import { networkOwnershipLabels } from "@lando/container-runtime/native-ownership";
import { makePluginStateStore } from "@lando/engine/plugins/context-state";
import * as AppPlanSanitizerLayer from "@lando/engine/subsystems/host-proxy/plan-sanitizer-live";
import { hostProxyRunLandoFeature } from "@lando/engine/subsystems/host-proxy/transport-feature";
import { withSshAgentOverlay } from "@lando/engine/subsystems/ssh-agent/overlay";
import { SSH_AGENT_PLAN_EXTENSION_KEY } from "@lando/engine/subsystems/ssh/intent";
import { type PodmanApiClient, makeRuntimeProvider } from "@lando/provider-podman";
import {
  AGENT_SOCKET_CONTAINER_DIR,
  AbsolutePath,
  AppId,
  type AppPlan,
  GPG_AGENT_SOCKET_NAME,
  PortNumber,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
  appIdentityKey,
} from "@lando/sdk/schema";
import { AppPlanSanitizer } from "@lando/sdk/services";
import { makeStateStore } from "@lando/state-store/service";
import { DateTime, Effect } from "effect";

import { loadAppliedPlan } from "../src/applied-state.ts";
import { ownerOnlyFileAccess } from "./private-file-access.ts";

const providerId = ProviderId.make("podman");
const appId = AppId.make("overlay-app");
const serviceName = ServiceName.make("web");
const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-09-25T00:00:00Z"),
  source: "provider-podman applied-plan sanitizer",
  runtime: 4 as const,
};
const temporaryDirectories: string[] = [];

const service: ServicePlan = {
  name: serviceName,
  type: "lando",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "node:22-alpine" },
  environment: { KEEP_ME: "yes" },
  connection: {
    family: "mysql",
    port: PortNumber.make(3306),
    creds: { user: "user", database: "app", password: { _tag: "SecretRef", reference: "DB_PASSWORD" } },
  },
  mounts: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: { [SSH_AGENT_PLAN_EXTENSION_KEY]: { mode: "host" } },
};

const toolingSite = {
  id: "tooling-site",
  path: ["tooling", "cleanup", "cmd"],
  source: { file: "/tmp/overlay-app/.lando.yml", layer: "base", path: ["tooling", "cleanup", "cmd"] },
  template: {
    whole: true,
    segments: [
      {
        kind: "InterpolationSegment",
        expression: { kind: "Path", head: "vars", segments: [{ type: "prop", name: "value" }] },
        trimLeft: false,
        trimRight: false,
      },
    ],
  },
  expression: "{{ vars.value }}",
  captures: {},
};
const basePlan: AppPlan = {
  valueModel: 1,
  id: appId,
  name: "Overlay App",
  slug: "overlay-app",
  root: AbsolutePath.make("/tmp/overlay-app"),
  identity: {
    appRoot: AbsolutePath.make("/tmp/overlay-app"),
    ownerKey: appIdentityKey("owner", "/tmp/overlay-app"),
  },
  provider: providerId,
  services: { [serviceName]: service },
  routes: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {
    "@lando/core/effective-tooling": {
      tasks: {
        cleanup: { cmd: "{{ vars.value }}", env: { TOKEN: { _tag: "SecretRef", reference: "TOKEN" } } },
      },
      internalNames: [],
    },
    "@lando/core/invocation-authority": { sites: [toolingSite] },
  },
};

const overlaidPlan = (): AppPlan => {
  const ssh = Effect.runSync(
    withSshAgentOverlay(basePlan, {
      kind: "ssh",
      socketName: "agent.sock",
      mount: { _tag: "volume", volume: "ssh-agent" },
    }),
  );
  return {
    ...ssh,
    events: { "pre-stop": [{ step: "stale-hook", source: "project", sourceIndex: 0, status: "active" }] },
    extensions: {
      ...ssh.extensions,
      "@lando/core/invocation-authority": {
        sites: [
          toolingSite,
          { ...toolingSite, id: "project-site", path: ["events", "pre-stop", 0] },
          { ...toolingSite, id: "host-site", path: ["hostEvents", "pre-stop", 0] },
        ],
      },
    },
    services: Object.fromEntries(
      Object.values(ssh.services).map((planned) => {
        const environment: Record<string, ServicePlan["environment"][string]> = { ...planned.environment };
        const mounts = [...planned.mounts];
        const extensions = { ...planned.extensions };
        hostProxyRunLandoFeature({
          appId: String(appId),
          sessionId: "proxy-session",
          token: "proxy-token",
          shimPath: "/tmp/lando-shim",
          socketPath: "/tmp/host-proxy.sock",
          url: "http://127.0.0.1:9",
        }).apply({
          addExtension: (name, value) => {
            extensions[name] = value;
          },
          addEnv: (name, value) => {
            environment[name] = value;
          },
          addMount: (mount) => {
            mounts.push(mount);
          },
        });
        environment.GNUPGHOME = "/tmp/lando-gnupg";
        environment.LANDO_GPG_AGENT_SOCKET = `${AGENT_SOCKET_CONTAINER_DIR.gpg}/${GPG_AGENT_SOCKET_NAME}`;
        environment.LANDO_GPG_KEYRING = "/run/lando/gpg-agent-keys";
        mounts.push({
          type: "volume",
          store: "gpg-agent",
          target: PortablePath.make(AGENT_SOCKET_CONTAINER_DIR.gpg),
          readOnly: true,
        });
        return [planned.name, { ...planned, environment, mounts, extensions }];
      }),
    ),
  };
};

const makePodmanApi = (): PodmanApiClient => {
  const containers = new Set<string>();
  const running = new Set<string>();
  const request = (input: EngineHttpRequest) =>
    Effect.sync(() => {
      if (input.method === "GET" && input.path.includes("/images/") && input.path.endsWith("/json")) {
        return {
          status: 200,
          body: JSON.stringify({ Os: "linux", Architecture: "amd64", RepoDigests: ["img@sha256:test"] }),
        };
      }
      if (input.method === "GET" && input.path.startsWith("/networks/")) {
        const name = decodeURIComponent(input.path.slice("/networks/".length));
        return {
          status: 200,
          body: JSON.stringify({
            Id: `owned-${name}`,
            Name: name,
            Driver: "bridge",
            Labels: networkOwnershipLabels(basePlan),
          }),
        };
      }
      const container = input.path.match(/^\/containers\/([^/?]+)(?:\/json|\/start)?$/u)?.[1];
      if (input.method === "GET" && input.path.endsWith("/json") && container !== undefined) {
        return containers.has(decodeURIComponent(container))
          ? {
              status: 200,
              body: JSON.stringify({ State: { Running: running.has(decodeURIComponent(container)) } }),
            }
          : { status: 404, body: "{}" };
      }
      if (input.method === "POST" && input.path.startsWith("/containers/create?name=")) {
        const name = new URLSearchParams(input.path.slice(input.path.indexOf("?") + 1)).get("name");
        if (name !== null) containers.add(name);
        return { status: 201, body: "{}" };
      }
      if (input.method === "POST" && container !== undefined && input.path.endsWith("/start")) {
        running.add(decodeURIComponent(container));
        return { status: 204, body: "" };
      }
      return { status: 204, body: "" };
    });
  return {
    info: Effect.succeed({ host: { arch: "x64" }, version: { Version: "6.0.0" } }),
    ping: Effect.void,
    request,
  };
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("an overlaid plan applied through provider-podman is persisted without the overlay", async () => {
  // Given
  const stateDir = await mkdtemp(join(tmpdir(), "lando-provider-podman-sanitizer-"));
  temporaryDirectories.push(stateDir);
  const state = makePluginStateStore(
    makeStateStore({ privateFileAccess: ownerOnlyFileAccess }),
    AbsolutePath.make(stateDir),
    ownerOnlyFileAccess,
  );
  const overlaid = overlaidPlan();
  const provider = await Effect.runPromise(
    makeRuntimeProvider({
      podmanApi: makePodmanApi(),
      platform: "linux",
      env: {},
      conflictDetector: () => Effect.void,
      appliedPlanState: state,
    }).pipe(Effect.provide(AppPlanSanitizerLayer.layer)),
  );

  // When
  await Effect.runPromise(Effect.scoped(provider.apply(overlaid, { reconcile: true })));

  // Then
  const persisted = await Effect.runPromise(loadAppliedPlan(state, appId));
  expect(overlaid.services[serviceName]?.environment.SSH_AUTH_SOCK).toBe("/run/lando/ssh-agent/agent.sock");
  expect(overlaid.services[serviceName]?.environment.LANDO_HOST_PROXY_TOKEN).toBeUndefined();
  expect(overlaid.services[serviceName]?.mounts).toContainEqual(
    expect.objectContaining({ target: "/run/lando/host-proxy/credentials", readOnly: true }),
  );
  expect(overlaid.services[serviceName]?.environment.GNUPGHOME).toBe("/tmp/lando-gnupg");
  expect(persisted).toEqual(basePlan);
});

test.each(["per-app", "record", "memory"] as const)(
  "%s projection removes hooks but retains typed tooling and connection authority",
  async (layout) => {
    const stateDir = await mkdtemp(join(tmpdir(), "lando-event-projection-"));
    temporaryDirectories.push(stateDir);
    const state = makePluginStateStore(
      makeStateStore({ privateFileAccess: ownerOnlyFileAccess }),
      AbsolutePath.make(stateDir),
      ownerOnlyFileAccess,
    );
    const desired = overlaidPlan();
    const projected = await Effect.runPromise(
      Effect.gen(function* () {
        const sanitizer = yield* AppPlanSanitizer;
        if (layout === "memory") {
          const cache = makeAppliedPlanCache({
            providerId,
            providerName: "podman",
            sanitizeAppliedPlan: sanitizer.sanitizeForPersistence,
            load: () => Effect.succeed(undefined),
            persist: () => Effect.void,
            remove: () => Effect.void,
          });
          yield* cache.rememberPlan(desired, true);
          return yield* cache.resolvePlan(desired.id);
        }
        const store =
          layout === "per-app"
            ? makeAppliedPlanStore({ providerId: "lando", layout })
            : makeAppliedPlanStore({ providerId: "podman", layout });
        yield* store.persistAppliedPlan(state, desired);
        return yield* store.loadAppliedPlan(state, desired.id);
      }).pipe(Effect.provide(AppPlanSanitizerLayer.layer)),
    );
    expect(projected).toEqual(basePlan);
    expect(desired.events?.["pre-stop"]).toHaveLength(1);
    expect(desired.extensions["@lando/core/invocation-authority"]).toMatchObject({
      sites: expect.arrayContaining([
        expect.objectContaining({ id: "project-site" }),
        expect.objectContaining({ id: "host-site" }),
      ]),
    });
  },
);
