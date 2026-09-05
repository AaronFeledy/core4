import { describe, expect, test } from "bun:test";
import { stripHostProxyRunLando } from "@lando/core/testing";
import { Effect, Stream } from "effect";

import { resolveLiveProviderSocket } from "@lando/core/testing";
import type { ImagePullProgressEvent } from "@lando/sdk/events";

import { makePodmanApiClient, makeProviderLayer } from "@lando/provider-lando";
import { type EventService, RuntimeProvider } from "@lando/sdk/services";
import { liveIntegrationEligibility, liveIntegrationTestName } from "./live-integration.ts";

const imagePullLive = liveIntegrationEligibility([
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

  test.skipIf(!imagePullLive.available)(
    liveIntegrationTestName(
      "pulls a live image through the Podman socket when explicitly enabled",
      imagePullLive,
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
