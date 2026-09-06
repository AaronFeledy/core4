import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";

import type { EngineHttpApi, ProviderErrorContext } from "../src/engine-api.ts";
import { getContainerDiedEvents, parseContainerEventPayloads } from "../src/podman/container-events.ts";

const diedEvent = {
  Type: "container",
  Action: "died",
  OOMKilled: true,
  Actor: { Attributes: { name: "lando-myapp-web", "dev.lando.app": "myapp" } },
};

const landoCtx: ProviderErrorContext = {
  providerId: "lando",
  remediation: "Run `lando doctor`, then `lando setup` if the runtime is unhealthy.",
};
const podmanCtx: ProviderErrorContext = {
  providerId: "podman",
  remediation: "Start the Podman service, then retry.",
};
const contexts: ReadonlyArray<ProviderErrorContext> = [landoCtx, podmanCtx];

describe("podman container died event collection", () => {
  test("parses Podman JSON Lines event history and array responses", () => {
    expect(parseContainerEventPayloads(`${JSON.stringify(diedEvent)}\n{"Type":"image"}\n`)).toEqual([
      diedEvent,
      { Type: "image" },
    ]);
    expect(parseContainerEventPayloads(JSON.stringify([diedEvent]))).toEqual([diedEvent]);
    expect(parseContainerEventPayloads("not json\n")).toEqual([]);
  });

  for (const ctx of contexts) {
    test(`requests finite Podman died events and returns raw payloads for ${ctx.providerId}`, async () => {
      // Given
      const paths: string[] = [];
      const api: EngineHttpApi = {
        request: (request) =>
          Effect.sync(() => {
            paths.push(request.path);
            return { status: 200, body: JSON.stringify([diedEvent]) };
          }),
      };

      // When
      const payloads = await Effect.runPromise(getContainerDiedEvents(api, { ctx }));

      // Then
      expect(payloads).toEqual([diedEvent]);
      expect(paths[0]).toContain("/libpod/events");
      expect(paths[0]).toContain("since=");
      expect(paths[0]).toContain("until=");
      expect(paths[0]).not.toContain("stream=false");
      expect(decodeURIComponent(paths[0] ?? "")).toContain("container");
      expect(decodeURIComponent(paths[0] ?? "")).toContain("die");
    });

    test(`maps event collection failures to the ${ctx.providerId} provider id`, async () => {
      // Given
      const api: EngineHttpApi = {
        request: () => Effect.succeed({ status: 500, body: "registry ACCESS_TOKEN=s3cr3t" }),
      };

      // When
      const error = await Effect.runPromise(getContainerDiedEvents(api, { ctx }).pipe(Effect.flip));

      // Then
      expect(error).toBeInstanceOf(ProviderUnavailableError);
      expect(error.providerId).toBe(ctx.providerId);
      expect(error.remediation).toBe(ctx.remediation);
      expect(JSON.stringify(error)).not.toContain("s3cr3t");
    });
  }

  test("enriches died events with OOMKilled from container inspect", async () => {
    const eventWithoutOom = {
      ...diedEvent,
      OOMKilled: undefined,
      id: "oom-container-id",
    };
    const paths: string[] = [];
    const api: EngineHttpApi = {
      request: (request) =>
        Effect.sync(() => {
          paths.push(request.path);
          return request.path.startsWith("/libpod/events")
            ? { status: 200, body: JSON.stringify([eventWithoutOom]) }
            : { status: 200, body: JSON.stringify({ State: { OOMKilled: true } }) };
        }),
    };

    const payloads = await Effect.runPromise(getContainerDiedEvents(api, { ctx: landoCtx }));

    expect(paths).toEqual([expect.stringContaining("/libpod/events"), "/containers/oom-container-id/json"]);
    expect(payloads).toEqual([{ ...eventWithoutOom, OOMKilled: true }]);
  });

  test("fails with the caller provider id when the client cannot issue requests", async () => {
    // Given a client without request support
    // When
    const error = await Effect.runPromise(getContainerDiedEvents({}, { ctx: podmanCtx }).pipe(Effect.flip));

    // Then
    expect(error.providerId).toBe("podman");
    expect(error.remediation).toBe(podmanCtx.remediation);
  });
});
