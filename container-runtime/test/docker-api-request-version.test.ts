import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { Cause, Effect, Exit, Option } from "effect";
import { makeDockerApiClient, resetDockerApiPrefixCache } from "../src/docker/api-client.ts";
import { dockerApiEndpointKey, peekDockerApiPrefix } from "../src/docker/api-prefix.ts";

beforeEach(resetDockerApiPrefixCache);
afterEach(resetDockerApiPrefixCache);

const ctx = { providerId: "docker", remediation: "Start Docker.", env: {} } as const;

describe("Docker request-scoped API version", () => {
  test.each([
    {
      requested: "1.48" as const,
      advertised: "1.52",
      warm: true,
      minimum: "1.24",
      expected: "1.48",
      negotiated: "1.43",
    },
    {
      requested: "1.48" as const,
      advertised: "1.52",
      warm: true,
      minimum: "1.44",
      expected: "1.48",
      negotiated: "1.44",
    },
    {
      requested: "1.48" as const,
      advertised: "1.44",
      warm: true,
      minimum: "1.24",
      expected: "1.43",
      negotiated: "1.43",
    },
    {
      requested: "1.48" as const,
      advertised: undefined,
      warm: true,
      minimum: "1.24",
      expected: "1.43",
      negotiated: "1.43",
    },
    {
      requested: "1.48" as const,
      advertised: "1.52",
      warm: false,
      minimum: "1.24",
      expected: "1.43",
      negotiated: "1.43",
    },
    {
      requested: "1.45" as const,
      advertised: "1.45",
      warm: true,
      minimum: "1.24",
      expected: "1.45",
      negotiated: "1.43",
    },
    {
      requested: "1.45" as const,
      advertised: "1.52",
      warm: true,
      minimum: "1.24",
      expected: "1.45",
      negotiated: "1.43",
    },
    {
      requested: "1.45" as const,
      advertised: "1.52",
      warm: true,
      minimum: "1.44",
      expected: "1.45",
      negotiated: "1.44",
    },
    {
      requested: "1.45" as const,
      advertised: "1.44",
      warm: true,
      minimum: "1.24",
      expected: "refusal",
      negotiated: "1.43",
    },
    {
      requested: "1.45" as const,
      advertised: undefined,
      warm: true,
      minimum: "1.24",
      expected: "refusal",
      negotiated: "1.43",
    },
    {
      requested: "1.45" as const,
      advertised: undefined,
      warm: true,
      minimum: "1.44",
      expected: "refusal",
      negotiated: "1.44",
    },
    {
      requested: "1.45" as const,
      advertised: "1.52",
      warm: false,
      minimum: "1.24",
      expected: "refusal",
      negotiated: "1.43",
    },
  ])(
    "selects $expected for requested=$requested advertised=$advertised warm=$warm daemon minimum=$minimum",
    async (scenario) => {
      // Given
      const paths: string[] = [];
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          await request.text();
          const path = new URL(request.url).pathname;
          paths.push(path);
          const headers = {
            "Min-API-Version": scenario.minimum,
            ...(scenario.advertised === undefined ? {} : { "Api-Version": scenario.advertised }),
          };
          if (scenario.minimum === "1.44" && path.startsWith("/v1.43/")) {
            return Response.json(
              { message: "client version 1.43 is too old. Minimum supported API version is 1.44" },
              { status: 400, headers },
            );
          }
          return Response.json({}, { status: path.endsWith("/create") ? 201 : 200, headers });
        },
      });
      try {
        const client = makeDockerApiClient(server.url.origin, ctx, { env: {} });
        const request = client.request;
        if (request === undefined) throw new TypeError("Expected Docker request client");
        if (scenario.warm) await Effect.runPromise(client.info);
        const warmPaths = [...paths];

        // When
        const created = await Effect.runPromiseExit(
          request({
            method: "POST",
            path: "/containers/create",
            body:
              scenario.requested === "1.45"
                ? {
                    HostConfig: {
                      Mounts: [
                        {
                          Type: "volume",
                          Source: "data",
                          Target: "/data",
                          VolumeOptions: { Subpath: "tenant" },
                        },
                      ],
                    },
                  }
                : { NetworkingConfig: { EndpointsConfig: { app: { GwPriority: 1 } } } },
            minimumApiVersion: scenario.requested,
          }),
        );
        if (scenario.expected === "refusal") {
          expect(Exit.isFailure(created)).toBe(true);
          if (Exit.isFailure(created)) {
            const error = Option.getOrUndefined(Cause.findErrorOption(created.cause));
            expect(error).toBeInstanceOf(ProviderUnavailableError);
            if (error instanceof ProviderUnavailableError) {
              expect(error.operation).toBe("volume-subpath");
              expect(error.message).toContain("1.45");
              expect(error.remediation).toContain("volume root");
            }
          }
          // The fake daemon would return 201 while ignoring Subpath. Do not send it any POST.
          expect(paths).toEqual(warmPaths);
        } else {
          expect(Exit.isSuccess(created)).toBe(true);
          if (Exit.isSuccess(created)) expect(created.value.status).toBe(201);
        }
        await Effect.runPromise(request({ method: "GET", path: "/containers/web/json" }));
        await Effect.runPromise(makeDockerApiClient(server.url.origin, ctx, { env: {} }).info);

        // Then
        expect(paths).toEqual([
          ...warmPaths,
          ...(scenario.expected === "refusal" ? [] : [`/v${scenario.expected}/containers/create`]),
          `/v${scenario.negotiated}/containers/web/json`,
          `/v${scenario.negotiated}/info`,
        ]);
        expect(peekDockerApiPrefix(dockerApiEndpointKey(server.url.origin))?.prefix).toBe(
          `/v${scenario.negotiated}`,
        );
      } finally {
        await server.stop(true);
      }
    },
  );
});

describe("Docker request-scoped version with explicit prefixes", () => {
  test.each([
    {
      requested: "1.45" as const,
      prefix: "",
      override: "1.43",
      ordinary: "/v1.43",
      create: "/v1.45",
      source: "env",
    },
    {
      requested: "1.45" as const,
      prefix: "/v1.44",
      override: undefined,
      ordinary: "/v1.44",
      create: "/v1.45",
      source: "explicit",
    },
    {
      requested: "1.45" as const,
      prefix: "/engine/proxy",
      override: undefined,
      ordinary: "/engine/proxy",
      create: "/engine/proxy",
      source: "explicit",
    },
    {
      requested: "1.48" as const,
      prefix: "/engine/proxy",
      override: undefined,
      ordinary: "/engine/proxy",
      create: "/engine/proxy",
      source: "explicit",
    },
  ])("keeps ordinary requests at $ordinary with source=$source requested=$requested", async (scenario) => {
    const paths: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        await request.text();
        const path = new URL(request.url).pathname;
        paths.push(path);
        return Response.json(
          {},
          {
            status: path.endsWith("/create") ? 201 : 200,
            headers: { "Api-Version": "1.52", "Min-API-Version": "1.24" },
          },
        );
      },
    });
    try {
      const env = scenario.override === undefined ? {} : { DOCKER_API_VERSION: scenario.override };
      const host = `${server.url.origin}${scenario.prefix}`;
      const client = makeDockerApiClient(host, ctx, { env });
      if (client.request === undefined) throw new TypeError("Expected Docker request client");
      await Effect.runPromise(client.info);
      await Effect.runPromise(
        client.request({
          method: "POST",
          path: "/containers/create",
          body: {},
          minimumApiVersion: scenario.requested,
        }),
      );
      await Effect.runPromise(client.request({ method: "GET", path: "/containers/web/json" }));
      await Effect.runPromise(makeDockerApiClient(host, ctx, { env }).info);
      expect(paths).toEqual([
        `${scenario.ordinary}/info`,
        `${scenario.create}/containers/create`,
        `${scenario.ordinary}/containers/web/json`,
        `${scenario.ordinary}/info`,
      ]);
      expect(peekDockerApiPrefix(dockerApiEndpointKey(host))).toMatchObject({
        prefix: scenario.ordinary,
        source: scenario.source,
      });
    } finally {
      await server.stop(true);
    }
  });
});

describe("Docker routing-prefix cache isolation", () => {
  test.each([
    {
      first: "",
      second: "/engine/proxy",
      firstInfo: "/v1.43/info",
      secondInfo: "/engine/proxy/info",
      create: "/engine/proxy/containers/create",
      ordinary: "/engine/proxy/containers/web/json",
    },
    {
      first: "/engine/proxy",
      second: "",
      firstInfo: "/engine/proxy/info",
      secondInfo: "/v1.43/info",
      create: "/v1.45/containers/create",
      ordinary: "/v1.43/containers/web/json",
    },
  ])("keeps daemon routing separate when $first is warmed before $second", async (scenario) => {
    const paths: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        await request.text();
        const path = new URL(request.url).pathname;
        paths.push(path);
        return Response.json(
          {},
          {
            status: path.endsWith("/create") ? 201 : 200,
            headers: { "Api-Version": "1.52", "Min-API-Version": "1.24" },
          },
        );
      },
    });
    try {
      const first = makeDockerApiClient(`${server.url.origin}${scenario.first}`, ctx, { env: {} });
      const second = makeDockerApiClient(`${server.url.origin}${scenario.second}`, ctx, { env: {} });
      if (second.request === undefined) throw new TypeError("Expected Docker request client");
      await Effect.runPromise(first.info);
      await Effect.runPromise(second.info);
      await Effect.runPromise(
        second.request({ method: "POST", path: "/containers/create", body: {}, minimumApiVersion: "1.45" }),
      );
      await Effect.runPromise(second.request({ method: "GET", path: "/containers/web/json" }));
      await Effect.runPromise(first.info);
      expect(paths).toEqual([
        scenario.firstInfo,
        scenario.secondInfo,
        scenario.create,
        scenario.ordinary,
        scenario.firstInfo,
      ]);
    } finally {
      await server.stop(true);
    }
  });
});

describe("Docker custom-route subpath support proof", () => {
  test.each([undefined, "1.44", "unreadable"])(
    "refuses before POST when advertised API is %s",
    async (advertised) => {
      const paths: string[] = [];
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          await request.text();
          const path = new URL(request.url).pathname;
          paths.push(path);
          return Response.json(
            {},
            {
              status: path.endsWith("/create") ? 201 : 200,
              headers: {
                "Min-API-Version": "1.24",
                ...(advertised === undefined ? {} : { "Api-Version": advertised }),
              },
            },
          );
        },
      });
      try {
        const host = `${server.url.origin}/engine/proxy`;
        const client = makeDockerApiClient(host, ctx, { env: {} });
        if (client.request === undefined) throw new TypeError("Expected Docker request client");
        await Effect.runPromise(client.info);
        const exit = await Effect.runPromiseExit(
          client.request({
            method: "POST",
            path: "/containers/create",
            body: {
              HostConfig: {
                Mounts: [
                  { Type: "volume", Source: "data", Target: "/data", VolumeOptions: { Subpath: "tenant" } },
                ],
              },
            },
            minimumApiVersion: "1.45",
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
          expect(error).toBeInstanceOf(ProviderUnavailableError);
          if (error instanceof ProviderUnavailableError) expect(error.operation).toBe("volume-subpath");
        }
        expect(paths).toEqual(["/engine/proxy/info"]);
        await Effect.runPromise(client.request({ method: "GET", path: "/containers/web/json" }));
        expect(paths).toEqual(["/engine/proxy/info", "/engine/proxy/containers/web/json"]);
        expect(peekDockerApiPrefix(dockerApiEndpointKey(host))?.prefix).toBe("/engine/proxy");
      } finally {
        await server.stop(true);
      }
    },
  );
});
