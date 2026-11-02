import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { makeDockerApiClient, resetDockerApiPrefixCache } from "../src/docker/api-client.ts";
import { dockerApiEndpointKey, peekDockerApiPrefix } from "../src/docker/api-prefix.ts";

beforeEach(resetDockerApiPrefixCache);
afterEach(resetDockerApiPrefixCache);

const ctx = { providerId: "docker", remediation: "Start Docker.", env: {} } as const;

describe("Docker request-scoped API version", () => {
  test.each([
    { advertised: "1.52", warm: true, minimum: "1.24", expected: "1.48", negotiated: "1.43" },
    { advertised: "1.52", warm: true, minimum: "1.44", expected: "1.48", negotiated: "1.44" },
    { advertised: "1.44", warm: true, minimum: "1.24", expected: "1.43", negotiated: "1.43" },
    { advertised: undefined, warm: true, minimum: "1.24", expected: "1.43", negotiated: "1.43" },
    { advertised: "1.52", warm: false, minimum: "1.24", expected: "1.43", negotiated: "1.43" },
  ])("selects $expected with advertised=$advertised warm=$warm minimum=$minimum", async (scenario) => {
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
          minimumApiVersion: "1.48",
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
  });
});
