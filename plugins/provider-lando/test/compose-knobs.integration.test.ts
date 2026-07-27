import { describe, expect, test } from "bun:test";
import { DateTime, Effect } from "effect";

import { resolveLiveProviderSocket } from "@lando/core/testing";
import { bringUp, makePodmanApiClient } from "@lando/provider-lando";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";

// Live counterpart to `compose-knobs-bringup.test.ts`. That suite pins the
// create-request body this provider sends; this one pins that Podman actually
// applied it to the resulting container.

const providerId = ProviderId.make("lando");
const appId = AppId.make("composeknobsapp");
const appRoot = AbsolutePath.make("/tmp/lando-compose-knobs-app");
const containerName = "lando-composeknobsapp-web";
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-07-27T00:00:00Z"),
  source: "compose-knobs.integration.test",
  runtime: 4 as const,
};

const web: ServicePlan = {
  name: ServiceName.make("web"),
  type: "node",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "node:22-alpine" },
  command: ["node", "-e", "setInterval(() => {}, 1000)"],
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {
    compose: {
      privileged: true,
      ulimits: { nofile: { soft: 20_000, hard: 40_000 } },
      extra_hosts: { "knob-check.lando": "10.42.0.9" },
    },
  },
};

const plan: AppPlan = {
  id: appId,
  name: "Compose Knobs App",
  slug: "composeknobsapp",
  root: appRoot,
  provider: providerId,
  services: { [web.name]: web },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

const ulimitNames = (ulimits: unknown): ReadonlyArray<string> =>
  Array.isArray(ulimits) ? ulimits.map((entry) => String(field(entry, "Name"))) : [];

describe("provider-lando Compose runtime knobs (live)", () => {
  test.skipIf(resolveLiveProviderSocket() === undefined)(
    "Given privileged, ulimit, and host-entry knobs, when Podman creates the container, then inspect reports their live effects",
    async () => {
      const socketPath = resolveLiveProviderSocket()?.socketPath;
      expect(socketPath).toBeTruthy();
      const api = makePodmanApiClient(socketPath ?? "");
      const liveRequest = api.request;
      if (liveRequest === undefined) throw new Error("live Podman client exposes no request transport");

      try {
        await Effect.runPromise(bringUp(plan, { podmanApi: api }));

        const response = await Effect.runPromise(
          liveRequest({ method: "GET", path: `/containers/${containerName}/json` }),
        );
        expect(response.status).toBe(200);
        const hostConfig = field(JSON.parse(response.body) as unknown, "HostConfig");

        expect(field(hostConfig, "Privileged")).toBe(true);

        // Podman reports ulimits under its own naming, so the knob's bounds are
        // pinned against whichever entry carries the requested `nofile` limit.
        const ulimits = field(hostConfig, "Ulimits");
        const nofile = Array.isArray(ulimits)
          ? ulimits.find((entry) => String(field(entry, "Name")).toLowerCase().includes("nofile"))
          : undefined;
        expect(nofile, `no nofile ulimit among ${ulimitNames(ulimits).join(", ")}`).toBeDefined();
        expect(field(nofile, "Soft")).toBe(20_000);
        expect(field(nofile, "Hard")).toBe(40_000);

        expect(field(hostConfig, "ExtraHosts")).toEqual(
          expect.arrayContaining(["knob-check.lando:10.42.0.9"]),
        );
      } finally {
        await Effect.runPromise(
          Effect.either(liveRequest({ method: "POST", path: `/containers/${containerName}/stop` })),
        );
        await Effect.runPromise(
          Effect.either(liveRequest({ method: "DELETE", path: `/containers/${containerName}?force=true` })),
        );
      }
    },
    60_000,
  );
});
