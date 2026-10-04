import { describe, expect, test } from "bun:test";
import { stripHostProxyRunLando } from "@lando/engine/subsystems/host-proxy/transport-feature";
import { resolveLiveProviderSocket } from "@lando/engine/testing/live-provider-socket";
import { DateTime, Effect, Stream } from "effect";

import { libpodPullDialect } from "@lando/container-runtime/dialect";
import type {
  EngineHttpRequest,
  EngineHttpResponse,
  PodmanApiClient,
} from "@lando/container-runtime/engine-api";
import { buildImagePullRequest } from "@lando/container-runtime/image-pull";
import { makePodmanApiClient, layer as makeProviderLayer } from "@lando/provider-lando";
import type { ImagePullProgressEvent } from "@lando/sdk/events";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { type EventService, RuntimeProvider } from "@lando/sdk/services";
import { liveIntegrationEligibility, liveIntegrationTestName } from "./live-integration.ts";

const imagePullEligibility = liveIntegrationEligibility([
  {
    available: process.env.LANDO_TEST_IMAGE_PULL === "1",
    reason: "LANDO_TEST_IMAGE_PULL=1 is required",
  },
  { available: resolveLiveProviderSocket() !== undefined, reason: "a live Podman socket is required" },
]);

const encoder = new TextEncoder();
const bytes = (text: string): Uint8Array => encoder.encode(text);
type PublishedEvent = Parameters<typeof EventService.Service.publish>[0];
const isImagePullProgressEvent = (event: PublishedEvent): event is ImagePullProgressEvent =>
  event._tag === "image-pull-progress" && "eventName" in event && event.eventName === "image-pull-progress";
const captureImagePullProgress = (events: ImagePullProgressEvent[], event: PublishedEvent): void => {
  if (isImagePullProgressEvent(event)) events.push(event);
};

describe("provider pullArtifact", () => {
  test("pulls an artifact ref through the provider and publishes progress events", async () => {
    const events: ImagePullProgressEvent[] = [];
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({
            sanitizeAppliedPlan: stripHostProxyRunLando,
            platform: "linux",
            podmanApi: {
              info: Effect.succeed({ host: { arch: "x64" } }),
              ping: Effect.succeed(undefined),
              stream: () =>
                Stream.fromIterable([
                  bytes('{"stream":"Trying to pull docker.io/library/alpine:3.20.3..."}\n'),
                  bytes('{"status":"Downloading","progressDetail":{"current":100,"total":200}}\n'),
                ]),
            },
            eventService: {
              publish: (event) =>
                Effect.sync(() => {
                  captureImagePullProgress(events, event);
                }),
            },
          }),
        ),
      ),
    );

    const artifact = await Effect.runPromise(
      provider.pullArtifact({ ref: "docker.io/library/alpine:3.20.3" }),
    );

    expect(String(artifact.providerId)).toBe("lando");
    expect(artifact.ref).toBe("docker.io/library/alpine:3.20.3");
    expect(events).toHaveLength(2);
    expect(events[1]?.current).toBe(100);
    expect(events[1]?.total).toBe(200);
  });

  test("provider pullArtifact redacts registry credentials from progress events", async () => {
    const reference = "https://user:s3cr3tPass@registry.internal/team/img:1.0";
    const events: ImagePullProgressEvent[] = [];
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({
            sanitizeAppliedPlan: stripHostProxyRunLando,
            platform: "linux",
            podmanApi: {
              info: Effect.succeed({ host: { arch: "x64" } }),
              ping: Effect.succeed(undefined),
              stream: () => Stream.fromIterable([bytes(`{"stream":"Trying to pull ${reference}..."}\n`)]),
            },
            eventService: {
              publish: (event) =>
                Effect.sync(() => {
                  captureImagePullProgress(events, event);
                }),
            },
          }),
        ),
      ),
    );

    await Effect.runPromise(provider.pullArtifact({ ref: reference }));

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("s3cr3tPass");
    expect(serialized).toContain("[redacted]");
  });

  test.skipIf(!imagePullEligibility.available)(
    liveIntegrationTestName(
      "pulls a live image through the Podman socket when explicitly enabled",
      imagePullEligibility,
    ),
    async () => {
      const socketPath = resolveLiveProviderSocket()?.socketPath;
      expect(socketPath).toBeTruthy();
      const events: ImagePullProgressEvent[] = [];
      const provider = await Effect.runPromise(
        RuntimeProvider.pipe(
          Effect.provide(
            makeProviderLayer({
              sanitizeAppliedPlan: stripHostProxyRunLando,
              platform: "linux",
              podmanApi: makePodmanApiClient(socketPath ?? ""),
              eventService: {
                publish: (event) =>
                  Effect.sync(() => {
                    captureImagePullProgress(events, event);
                  }),
              },
            }),
          ),
        ),
      );

      const artifact = await Effect.runPromise(
        provider.pullArtifact({ ref: "docker.io/library/alpine:3.20.3" }),
      );

      expect(artifact.ref).toBe("docker.io/library/alpine:3.20.3");
      expect(events.length).toBeGreaterThan(0);
    },
  );
});

const applyProviderId = ProviderId.make("lando");
const applyAppId = AppId.make("mailpit-app");
const applyMetadata = {
  resolvedAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z"),
  source: "provider-lando/image-pull-provider.test.ts",
  runtime: 4 as const,
};
const applyRef = "axllent/mailpit:v1.30.1";

const makeApplyService = (compose?: Record<string, unknown>): ServicePlan => ({
  name: ServiceName.make("mailpit"),
  type: "test",
  provider: applyProviderId,
  primary: true,
  artifact: { kind: "ref", ref: applyRef },
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata: applyMetadata,
  extensions: compose === undefined ? {} : { compose },
});

const makeApplyPlan = (service: ServicePlan): AppPlan => ({
  id: applyAppId,
  name: "Mailpit App",
  slug: "mailpit-app",
  root: AbsolutePath.make("/tmp/mailpit-app"),
  provider: applyProviderId,
  services: { [service.name]: service },
  routes: [],
  networks: [],
  networking: { perAppBridge: { name: "lando-mailpit-app", driver: "bridge" } },
  stores: [],
  fileSync: [],
  metadata: applyMetadata,
  extensions: {},
});

const makeApplyApi = (inspectStatus = 404) => {
  const requests: string[] = [];
  const existing = new Set<string>();
  const api: PodmanApiClient = {
    info: Effect.succeed({ host: { arch: "x64" }, version: { Version: "6.0.0" } }),
    ping: Effect.void,
    request: (request: EngineHttpRequest) => {
      requests.push(`${request.method} ${request.path}`);
      const response = ((): EngineHttpResponse => {
        if (request.method === "GET" && request.path.startsWith("/networks/"))
          return { status: 404, body: "" };
        if (request.path === "/networks/create") return { status: 201, body: "" };
        if (request.method === "GET" && request.path.includes("/images/") && request.path.endsWith("/json")) {
          return { status: inspectStatus, body: "{}" };
        }
        if (request.method === "POST" && request.path.startsWith("/libpod/images/pull")) {
          return { status: 200, body: '{"status":"Pull complete"}\n' };
        }
        if (
          request.method === "GET" &&
          request.path.startsWith("/containers/") &&
          request.path.endsWith("/json")
        ) {
          const name = decodeURIComponent(request.path.slice("/containers/".length, -"/json".length));
          return existing.has(name)
            ? { status: 200, body: JSON.stringify({ State: { Running: true } }) }
            : { status: 404, body: "" };
        }
        if (request.path.startsWith("/containers/create?")) {
          const name = new URL(`http://localhost${request.path}`).searchParams.get("name");
          if (name !== null) existing.add(name);
          return { status: 201, body: "" };
        }
        if (request.path.endsWith("/start")) return { status: 204, body: "" };
        return { status: 500, body: `unexpected ${request.method} ${request.path}` };
      })();
      return Effect.succeed(response);
    },
  };
  return { api, requests };
};

const applyPlan = async (plan: AppPlan, api: PodmanApiClient) => {
  const provider = await Effect.runPromise(
    RuntimeProvider.pipe(
      Effect.provide(
        makeProviderLayer({
          sanitizeAppliedPlan: stripHostProxyRunLando,
          platform: "linux",
          podmanApi: api,
        }),
      ),
    ),
  );
  return Effect.runPromise(Effect.scoped(provider.apply(plan, { reconcile: false })));
};

describe("provider-lando apply image pull", () => {
  test("pre-pulls a missing image through the same ensure path", async () => {
    const fake = makeApplyApi();
    await applyPlan(makeApplyPlan(makeApplyService()), fake.api);

    const inspect = fake.requests.findIndex(
      (entry) => entry === `GET /libpod/images/${encodeURIComponent(applyRef)}/json`,
    );
    const pull = fake.requests.findIndex((entry) =>
      entry.startsWith(`POST ${buildImagePullRequest(applyRef, libpodPullDialect).path}`),
    );
    const create = fake.requests.findIndex((entry) => entry.startsWith("POST /containers/create?"));
    expect(inspect).toBeGreaterThan(-1);
    expect(pull).toBeGreaterThan(inspect);
    expect(create).toBeGreaterThan(pull);
  });

  test("forwards an explicit service platform on the libpod pull", async () => {
    const fake = makeApplyApi();
    await applyPlan(makeApplyPlan(makeApplyService({ platform: "linux/amd64" })), fake.api);

    expect(fake.requests).toContain(
      `POST ${buildImagePullRequest(applyRef, libpodPullDialect, { platform: "linux/amd64" }).path}`,
    );
  });
});
