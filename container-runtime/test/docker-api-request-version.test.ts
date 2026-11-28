import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { dockerApiEndpointKey } from "@lando/sdk/engine-placement";
import { Effect } from "effect";
import { makeDockerApiClient, resetDockerApiPrefixCache } from "../src/docker/api-client.ts";
import { peekDockerApiPrefix } from "../src/docker/api-prefix.ts";
import { dockerRequestPrefix } from "../src/docker/api-version.ts";

beforeEach(resetDockerApiPrefixCache);
afterEach(resetDockerApiPrefixCache);

const ctx = { providerId: "docker", remediation: "Start Docker.", env: {} } as const;

type Wanted = ReadonlyArray<"1.44" | "1.48">;

describe("Docker request-scoped API version", () => {
  test.each([
    {
      advertised: "1.52",
      warm: true,
      minimum: "1.24",
      wanted: ["1.48"],
      expected: "1.48",
      negotiated: "1.43",
    },
    {
      advertised: "1.52",
      warm: true,
      minimum: "1.44",
      wanted: ["1.48"],
      expected: "1.48",
      negotiated: "1.44",
    },
    {
      advertised: "1.44",
      warm: true,
      minimum: "1.24",
      wanted: ["1.48"],
      expected: "1.43",
      negotiated: "1.43",
    },
    {
      advertised: undefined,
      warm: true,
      minimum: "1.24",
      wanted: ["1.48"],
      expected: "1.43",
      negotiated: "1.43",
    },
    {
      advertised: "1.52",
      warm: false,
      minimum: "1.24",
      wanted: ["1.48"],
      expected: "1.43",
      negotiated: "1.43",
    },
    // The highest floor the daemon reaches: a 1.44-1.47 daemon gets 1.44 even when 1.48 is wanted too.
    {
      advertised: "1.43",
      warm: true,
      minimum: "1.24",
      wanted: ["1.44"],
      expected: "1.43",
      negotiated: "1.43",
    },
    {
      advertised: "1.45",
      warm: true,
      minimum: "1.24",
      wanted: ["1.44"],
      expected: "1.44",
      negotiated: "1.43",
    },
    {
      advertised: "1.49",
      warm: true,
      minimum: "1.24",
      wanted: ["1.44"],
      expected: "1.44",
      negotiated: "1.43",
    },
    {
      advertised: "1.43",
      warm: true,
      minimum: "1.24",
      wanted: ["1.48"],
      expected: "1.43",
      negotiated: "1.43",
    },
    {
      advertised: "1.45",
      warm: true,
      minimum: "1.24",
      wanted: ["1.48"],
      expected: "1.43",
      negotiated: "1.43",
    },
    {
      advertised: "1.49",
      warm: true,
      minimum: "1.24",
      wanted: ["1.48"],
      expected: "1.48",
      negotiated: "1.43",
    },
    {
      advertised: "1.43",
      warm: true,
      minimum: "1.24",
      wanted: ["1.44", "1.48"],
      expected: "1.43",
      negotiated: "1.43",
    },
    {
      advertised: "1.45",
      warm: true,
      minimum: "1.24",
      wanted: ["1.44", "1.48"],
      expected: "1.44",
      negotiated: "1.43",
    },
    {
      advertised: "1.49",
      warm: true,
      minimum: "1.24",
      wanted: ["1.48", "1.44"],
      expected: "1.48",
      negotiated: "1.43",
    },
  ] satisfies ReadonlyArray<{
    advertised: string | undefined;
    warm: boolean;
    minimum: string;
    wanted: Wanted;
    expected: string;
    negotiated: string;
  }>)(
    "selects $expected with advertised=$advertised warm=$warm minimum=$minimum wanted=$wanted",
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
        const created = await Effect.runPromise(
          request({
            method: "POST",
            path: "/containers/create",
            body: { NetworkingConfig: { EndpointsConfig: { app: { GwPriority: 1 } } } },
            minimumApiVersions: scenario.wanted,
          }),
        );
        await Effect.runPromise(request({ method: "GET", path: "/containers/web/json" }));
        await Effect.runPromise(makeDockerApiClient(server.url.origin, ctx, { env: {} }).info);

        // Then
        expect(created.status).toBe(201);
        expect(paths).toEqual([
          ...warmPaths,
          `/v${scenario.expected}/containers/create`,
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

describe("Docker feature API selection shared with capabilities", () => {
  const withDaemon = async (
    advertised: string,
    run: (origin: string, paths: string[]) => Promise<void>,
  ): Promise<void> => {
    const paths: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        await request.text();
        paths.push(new URL(request.url).pathname);
        return Response.json({}, { headers: { "Api-Version": advertised, "Min-API-Version": "1.24" } });
      },
    });
    try {
      await run(server.url.origin, paths);
    } finally {
      await server.stop(true);
    }
  };

  test.each([
    ["1.43", "1.43"],
    ["1.45", "1.44"],
    ["1.49", "1.44"],
  ])("a daemon advertising %s answers start-interval requests at %s", async (advertised, expected) => {
    await withDaemon(advertised, async (origin) => {
      const client = makeDockerApiClient(origin, ctx, { env: {} });
      // No live evidence before the endpoint has answered.
      expect(client.requestApiVersion?.(["1.44"])).toBeUndefined();
      await Effect.runPromise(client.info);
      expect(client.requestApiVersion?.(["1.44"])).toBe(expected);
    });
  });

  test("an explicit DOCKER_API_VERSION pin is never raised for a feature", async () => {
    await withDaemon("1.49", async (origin, paths) => {
      const client = makeDockerApiClient(origin, ctx, { env: { DOCKER_API_VERSION: "1.43" } });
      await Effect.runPromise(client.info);
      expect(client.requestApiVersion?.(["1.44", "1.48"])).toBe("1.43");
      const request = client.request;
      if (request === undefined) throw new TypeError("Expected Docker request client");
      await Effect.runPromise(
        request({ method: "POST", path: "/containers/create", body: {}, minimumApiVersions: ["1.44"] }),
      );
      expect(paths.at(-1)).toBe("/v1.43/containers/create");
    });
  });

  test("a feature never lowers a prefix that is already above its floor", () => {
    expect(
      dockerRequestPrefix({ prefix: "/v1.47", pinned: false, advertised: "1.49", wanted: ["1.44"] }),
    ).toBe("/v1.47");
    expect(
      dockerRequestPrefix({ prefix: "/v1.43", pinned: false, advertised: "1.49", wanted: ["1.44"] }),
    ).toBe("/v1.44");
  });
});
