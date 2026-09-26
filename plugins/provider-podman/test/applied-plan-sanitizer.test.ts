import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EngineHttpRequest } from "@lando/container-runtime/engine-api";
import { makePluginStateStore } from "@lando/engine/plugins/context-state";
import { AppPlanSanitizerLive } from "@lando/engine/subsystems/host-proxy/plan-sanitizer-live";
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
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { makeStateStore } from "@lando/state-store/service";
import { DateTime, Effect } from "effect";

import { loadAppliedPlan } from "../src/applied-state.ts";
import { ownerOnlyFileAccess } from "./private-file-access.ts";

const providerId = ProviderId.make("podman");
const appId = AppId.make("overlay-app");
const serviceName = ServiceName.make("web");
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-09-25T00:00:00Z"),
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
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: { [SSH_AGENT_PLAN_EXTENSION_KEY]: { mode: "host" } },
};

const basePlan: AppPlan = {
  id: appId,
  name: "Overlay App",
  slug: "overlay-app",
  root: AbsolutePath.make("/tmp/overlay-app"),
  provider: providerId,
  services: { [serviceName]: service },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

const overlaidPlan = (): AppPlan => {
  const ssh = withSshAgentOverlay(basePlan, {
    kind: "ssh",
    socketName: "agent.sock",
    mount: { _tag: "volume", volume: "ssh-agent" },
  });
  return {
    ...ssh,
    services: Object.fromEntries(
      Object.values(ssh.services).map((planned) => {
        const environment: Record<string, string> = { ...planned.environment };
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
          addEnv: (name, value) => {
            environment[name] = value;
          },
          addMount: (mount) => {
            mounts.push(mount);
          },
        });
        environment.GNUPGHOME = "/run/lando/gnupg";
        environment.LANDO_GPG_AGENT_SOCKET = `${AGENT_SOCKET_CONTAINER_DIR.gpg}/${GPG_AGENT_SOCKET_NAME}`;
        environment.LANDO_GPG_KEYRING = "/run/lando/gpg-agent-keys";
        mounts.push({
          type: "volume",
          source: "gpg-agent",
          target: PortablePath.make(AGENT_SOCKET_CONTAINER_DIR.gpg),
          readOnly: true,
          realization: "passthrough",
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
      if (input.method === "GET" && input.path.startsWith("/networks/")) return { status: 200, body: "{}" };
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
    }).pipe(Effect.provide(AppPlanSanitizerLive)),
  );

  // When
  await Effect.runPromise(Effect.scoped(provider.apply(overlaid, { reconcile: true })));

  // Then
  const persisted = await Effect.runPromise(loadAppliedPlan(state, appId));
  expect(overlaid.services[serviceName]?.environment.SSH_AUTH_SOCK).toBe("/run/lando/ssh-agent/agent.sock");
  expect(overlaid.services[serviceName]?.environment.LANDO_HOST_PROXY_TOKEN).toBe("proxy-token");
  expect(overlaid.services[serviceName]?.environment.GNUPGHOME).toBe("/run/lando/gnupg");
  expect(persisted).toEqual(basePlan);
});
