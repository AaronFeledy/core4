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
import { makePodmanApiClient } from "@lando/provider-lando";
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
import { makeProviderLayer } from "./provider-fixture.ts";

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
  test.each(["always", "missing", "never"] as const)(
    "reports the observed pinned digest for %s",
    async (policy) => {
      // Given
      const ref = `team/helper@sha256:${"a".repeat(64)}`;
      const requests: EngineHttpRequest[] = [];
      const provider = await Effect.runPromise(
        RuntimeProvider.pipe(
          Effect.provide(
            makeProviderLayer({
              sanitizeAppliedPlan: stripHostProxyRunLando,
              platform: "linux",
              podmanApi: {
                info: Effect.succeed({ host: { arch: "x64" } }),
                ping: Effect.void,
                request: (request) => {
                  requests.push(request);
                  return Effect.succeed({
                    status: 200,
                    body: JSON.stringify({ RepoDigests: ["team/helper@sha256:other", ref] }),
                  });
                },
                stream: (request) => {
                  requests.push(request);
                  return Stream.empty;
                },
              },
            }),
          ),
        ),
      );
      // When
      const artifact = await Effect.runPromise(provider.pullArtifact({ ref, policy }));
      // Then
      expect(artifact).toEqual({ providerId: applyProviderId, ref, digest: `sha256:${"a".repeat(64)}` });
      expect(requests).toEqual([
        ...(policy === "always" ? [libpodPullDialect.request(ref)] : []),
        { method: "GET", path: `/libpod/images/${encodeURIComponent(ref)}/json` },
      ]);
    },
  );

  test("reuses a present local image when policy is missing without a registry pull", async () => {
    // Given
    const fake = makeApplyApi(200);
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({
            sanitizeAppliedPlan: stripHostProxyRunLando,
            platform: "linux",
            podmanApi: fake.api,
          }),
        ),
      ),
    );

    // When
    const result = await Effect.runPromise(provider.pullArtifact({ ref: applyRef, policy: "missing" }));

    // Then
    expect(result).toEqual({ providerId: applyProviderId, ref: applyRef, digest: "sha256:test" });
    expect(fake.requests).toEqual([`GET /libpod/images/${encodeURIComponent(applyRef)}/json`]);
  });

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
              request: () =>
                Effect.succeed({
                  status: 200,
                  body: JSON.stringify({ RepoDigests: ["docker.io/library/alpine@sha256:test"] }),
                }),
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
    expect(artifact.digest).toBe("sha256:test");
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
              request: () => Effect.succeed({ status: 200, body: "{}" }),
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
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata: applyMetadata,
  extensions: compose === undefined ? {} : { compose },
});

const makeApplyPlan = (service: ServicePlan): AppPlan => ({
  valueModel: 1,
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
  const pulledImages = new Set<string>();
  const existing = new Set<string>();
  const api = {
    info: Effect.succeed({ host: { arch: "x64" }, version: { Version: "6.0.0" } }),
    ping: Effect.void,
    request: (request: EngineHttpRequest) => {
      requests.push(`${request.method} ${request.path}`);
      const response = ((): EngineHttpResponse => {
        if (request.method === "GET" && request.path.startsWith("/networks/"))
          return { status: 404, body: "" };
        if (request.path === "/networks/create") return { status: 201, body: "" };
        if (request.method === "GET" && request.path.includes("/images/") && request.path.endsWith("/json")) {
          const ref = decodeURIComponent(request.path.slice("/libpod/images/".length, -"/json".length));
          return {
            status: pulledImages.has(ref) ? 200 : inspectStatus,
            body: JSON.stringify({ RepoDigests: [`${ref}@sha256:test`] }),
          };
        }
        if (request.method === "POST" && request.path.startsWith("/libpod/images/pull")) {
          pulledImages.add(new URL(`http://localhost${request.path}`).searchParams.get("reference") ?? "");
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
  } satisfies PodmanApiClient;
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
  test("apply forwards the complete resolved environment callback", async () => {
    // Given
    const service = {
      ...makeApplyService(),
      environment: {
        PLAIN: "visible",
        TOKEN: { _tag: "SecretRef", reference: "API_TOKEN" } as const,
        SSH_AUTH_SOCK: "/run/lando/ssh-agent/agent.sock",
      },
    };
    const fake = makeApplyApi();
    const creates: unknown[] = [];
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({
            platform: "linux",
            sanitizeAppliedPlan: stripHostProxyRunLando,
            podmanApi: {
              ...fake.api,
              request: (request) => {
                if (request.path.startsWith("/containers/create?")) creates.push(request.body);
                return fake.api.request(request);
              },
            },
          }),
        ),
      ),
    );
    // When
    await Effect.runPromise(
      Effect.scoped(
        provider.apply(makeApplyPlan(service), {
          reconcile: false,
          resolveServiceEnvironment: () =>
            Effect.succeed({ ...service.environment, TOKEN: "resolved-canary" }),
        }),
      ),
    );
    // Then
    expect(creates).toEqual([
      expect.objectContaining({
        Env: ["PLAIN=visible", "TOKEN=resolved-canary", "SSH_AUTH_SOCK=/run/lando/ssh-agent/agent.sock"],
      }),
    ]);
  });

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
