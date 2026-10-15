import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type Server, type Socket, createServer } from "node:net";
import { Effect } from "effect";

import { makeDockerApiClient, resetDockerApiPrefixCache } from "../src/docker/api-client.ts";
import { dockerApiEndpointKey, peekDockerApiPrefix } from "../src/docker/api-prefix.ts";
import { isDockerApiVersionError } from "../src/docker/api-version.ts";

const ctx = { providerId: "docker", remediation: "Start Docker." } as const;

beforeEach(resetDockerApiPrefixCache);
afterEach(resetDockerApiPrefixCache);

interface DaemonPolicy {
  readonly minApiVersion?: string;
  readonly apiVersion?: string;
  readonly infoBody?: string;
  readonly rejectBelowMin?: boolean;
  readonly omitMinHeaderOnSuccess?: boolean;
}

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
}

const versionHeaders = (policy: DaemonPolicy, status: number): string[] => [
  `Api-Version: ${policy.apiVersion ?? "1.43"}`,
  ...(policy.minApiVersion === undefined ||
  (status >= 200 && status < 300 && policy.omitMinHeaderOnSuccess === true)
    ? []
    : [`Min-API-Version: ${policy.minApiVersion}`]),
];

const httpResponse = (status: number, body: string, policy: DaemonPolicy): string => {
  const headers = [
    `HTTP/1.1 ${status} Test`,
    "Content-Type: application/json",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "Connection: close",
    ...versionHeaders(policy, status),
  ];
  return `${headers.join("\r\n")}\r\n\r\n${body}`;
};

const versionFromPath = (path: string): string | undefined => {
  const match = /^\/v(\d+\.\d+)\//u.exec(path);
  return match?.[1];
};

const compare = (left: string, right: string): number => {
  const [leftMajor, leftMinor] = left.split(".").map(Number);
  const [rightMajor, rightMinor] = right.split(".").map(Number);
  if ((leftMajor ?? 0) !== (rightMajor ?? 0)) return (leftMajor ?? 0) - (rightMajor ?? 0);
  return (leftMinor ?? 0) - (rightMinor ?? 0);
};

const responseFor = (policy: DaemonPolicy, requestPath: string): string => {
  if (requestPath === "/_ping" || requestPath === "/version") {
    throw new Error(`unexpected unversioned probe ${requestPath}`);
  }
  const version = versionFromPath(requestPath);
  const min = policy.minApiVersion;
  if (
    policy.rejectBelowMin === true &&
    min !== undefined &&
    version !== undefined &&
    compare(version, min) < 0
  ) {
    return httpResponse(
      400,
      JSON.stringify({
        message: `client version ${version} is too old. Minimum supported API version is ${min}`,
      }),
      policy,
    );
  }
  if (requestPath.endsWith("/info")) {
    return httpResponse(200, policy.infoBody ?? JSON.stringify({ Architecture: "x86_64" }), policy);
  }
  return httpResponse(404, JSON.stringify({ message: "No such container: missing" }), policy);
};

const listen = (server: Server): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("expected a TCP address"));
        return;
      }
      resolve(address.port);
    });
  });

const close = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((cause) => (cause === undefined ? resolve() : reject(cause)));
  });

const withFakeDaemon = async <A>(
  policy: DaemonPolicy,
  action: (input: { readonly host: string; readonly requests: readonly RecordedRequest[] }) => Promise<A>,
): Promise<A> => {
  const requests: RecordedRequest[] = [];
  const server = createServer((socket: Socket) => {
    socket.once("data", (chunk) => {
      const requestLine = chunk.toString("utf8").split("\r\n")[0] ?? "";
      const [method, path] = requestLine.split(" ");
      requests.push({ method: method ?? "", path: path ?? "" });
      try {
        socket.end(responseFor(policy, path ?? ""));
      } catch (cause) {
        socket.destroy();
        throw cause;
      }
    });
  });
  const port = await listen(server);
  try {
    return await action({ host: `http://127.0.0.1:${port}`, requests });
  } finally {
    await close(server);
  }
};

describe("Docker API fake-daemon negotiation", () => {
  test("stays on 1.43 for a 1.43-only daemon", async () => {
    await withFakeDaemon({ apiVersion: "1.43" }, async ({ host, requests }) => {
      const client = makeDockerApiClient(host, ctx);
      const info = await Effect.runPromise(client.info);
      await Effect.runPromise(client.info);
      expect(info).toEqual({ Architecture: "x86_64" });
      expect(requests.map((entry) => entry.path)).toEqual(["/v1.43/info", "/v1.43/info"]);
    });
  });

  test("retries once when the daemon minimum is 1.44", async () => {
    await withFakeDaemon(
      { minApiVersion: "1.44", apiVersion: "1.51", rejectBelowMin: true },
      async ({ host, requests }) => {
        const client = makeDockerApiClient(host, ctx);
        const info = await Effect.runPromise(client.info);
        await Effect.runPromise(client.info);
        expect(info).toEqual({ Architecture: "x86_64" });
        expect(requests.map((entry) => entry.path)).toEqual(["/v1.43/info", "/v1.44/info", "/v1.44/info"]);
      },
    );
  });

  test("keeps 1.43 when the daemon publishes a wider compatible range", async () => {
    await withFakeDaemon({ minApiVersion: "1.24", apiVersion: "1.45" }, async ({ host, requests }) => {
      const client = makeDockerApiClient(host, ctx);
      await Effect.runPromise(client.info);
      expect(requests.map((entry) => entry.path)).toEqual(["/v1.43/info"]);
    });
  });

  test("treats a missing MinAPIVersion as no minimum", async () => {
    await withFakeDaemon({ apiVersion: "1.45" }, async ({ host, requests }) => {
      const client = makeDockerApiClient(host, ctx);
      await Effect.runPromise(client.info);
      expect(requests.map((entry) => entry.path)).toEqual(["/v1.43/info"]);
    });
  });

  test("stays on 1.43 for a Podman-style 200 that advertises ApiVersion 1.41", async () => {
    await withFakeDaemon(
      {
        apiVersion: "1.41",
        minApiVersion: "1.24",
        infoBody: JSON.stringify({
          Architecture: "amd64",
          ServerVersion: "4.9.3",
        }),
      },
      async ({ host, requests }) => {
        const client = makeDockerApiClient(host, ctx);
        const info = await Effect.runPromise(client.info);
        await Effect.runPromise(client.info);
        expect(info).toEqual({ Architecture: "amd64", ServerVersion: "4.9.3" });
        expect(requests.map((entry) => entry.path)).toEqual(["/v1.43/info", "/v1.43/info"]);
      },
    );
  });

  test("keeps the raised 1.44 prefix when the successful retry omits MinAPIVersion", async () => {
    await withFakeDaemon(
      { minApiVersion: "1.44", apiVersion: "1.52", rejectBelowMin: true, omitMinHeaderOnSuccess: true },
      async ({ host, requests }) => {
        const client = makeDockerApiClient(host, ctx);
        await Effect.runPromise(client.info);
        await Effect.runPromise(client.info);
        expect(requests.map((entry) => entry.path)).toEqual(["/v1.43/info", "/v1.44/info", "/v1.44/info"]);
      },
    );
  });

  test("fails when the daemon minimum is newer than the tested maximum", async () => {
    await withFakeDaemon(
      { minApiVersion: "1.50", apiVersion: "1.55", rejectBelowMin: true },
      async ({ host, requests }) => {
        const client = makeDockerApiClient(host, ctx);
        const failure = await Effect.runPromise(client.info.pipe(Effect.flip));
        expect(isDockerApiVersionError(failure)).toBe(true);
        expect(failure.message).toContain("1.43-1.44");
        expect(failure.message).toContain("1.50-1.55");
        expect(requests.map((entry) => entry.path)).toEqual(["/v1.43/info"]);
      },
    );
  });

  test("honors DOCKER_API_VERSION and skips the preferred 1.43 probe", async () => {
    await withFakeDaemon(
      { minApiVersion: "1.44", apiVersion: "1.51", rejectBelowMin: true },
      async ({ host, requests }) => {
        const previous = process.env.DOCKER_API_VERSION;
        process.env.DOCKER_API_VERSION = "1.44";
        try {
          const client = makeDockerApiClient(host, ctx);
          await Effect.runPromise(client.info);
          expect(requests.map((entry) => entry.path)).toEqual(["/v1.44/info"]);
        } finally {
          if (previous === undefined) Reflect.deleteProperty(process.env, "DOCKER_API_VERSION");
          else process.env.DOCKER_API_VERSION = previous;
        }
      },
    );
  });

  test("lets an explicit DOCKER_HOST apiPrefix win over DOCKER_API_VERSION", async () => {
    await withFakeDaemon(
      { minApiVersion: "1.44", apiVersion: "1.51", rejectBelowMin: true },
      async ({ host, requests }) => {
        const previous = process.env.DOCKER_API_VERSION;
        process.env.DOCKER_API_VERSION = "1.43";
        try {
          const client = makeDockerApiClient(`${host}/v1.44`, ctx);
          await Effect.runPromise(client.info);
          expect(requests.map((entry) => entry.path)).toEqual(["/v1.44/info"]);
        } finally {
          if (previous === undefined) Reflect.deleteProperty(process.env, "DOCKER_API_VERSION");
          else process.env.DOCKER_API_VERSION = previous;
        }
      },
    );
  });

  test("keeps a Docker 29 prefix when a later request 404s", async () => {
    await withFakeDaemon(
      { minApiVersion: "1.44", apiVersion: "1.52", rejectBelowMin: true, omitMinHeaderOnSuccess: true },
      async ({ host, requests }) => {
        const client = makeDockerApiClient(host, ctx);
        const request = client.request;
        if (request === undefined) throw new Error("expected request client");
        await Effect.runPromise(client.info);
        const missing = await Effect.runPromise(request({ method: "GET", path: "/containers/missing/json" }));
        await Effect.runPromise(client.info);
        expect(missing.status).toBe(404);
        expect(missing.body).toContain("No such container");
        expect(isDockerApiVersionError(missing)).toBe(false);
        expect(peekDockerApiPrefix(dockerApiEndpointKey(host))).toMatchObject({
          prefix: "/v1.44",
          source: "negotiated",
        });
        expect(requests.map((entry) => entry.path)).toEqual([
          "/v1.43/info",
          "/v1.44/info",
          "/v1.44/containers/missing/json",
          "/v1.44/info",
        ]);
      },
    );
  });

  test("does not turn a Podman-style 404 into a version error", async () => {
    await withFakeDaemon(
      {
        apiVersion: "1.41",
        minApiVersion: "1.24",
        infoBody: JSON.stringify({ Architecture: "amd64", ServerVersion: "4.9.3" }),
      },
      async ({ host, requests }) => {
        const client = makeDockerApiClient(host, ctx);
        const request = client.request;
        if (request === undefined) throw new Error("expected request client");
        await Effect.runPromise(client.info);
        const missing = await Effect.runPromise(request({ method: "GET", path: "/containers/missing/json" }));
        expect(missing.status).toBe(404);
        expect(isDockerApiVersionError(missing)).toBe(false);
        expect(peekDockerApiPrefix(dockerApiEndpointKey(host))).toMatchObject({
          prefix: "/v1.43",
          source: "negotiated",
        });
        expect(requests.map((entry) => entry.path)).toEqual([
          "/v1.43/info",
          "/v1.43/containers/missing/json",
        ]);
      },
    );
  });

  test("single-flights cold-start negotiation across parallel requests", async () => {
    await withFakeDaemon(
      { minApiVersion: "1.44", apiVersion: "1.52", rejectBelowMin: true },
      async ({ host, requests }) => {
        const client = makeDockerApiClient(host, ctx);
        await Promise.all([
          Effect.runPromise(client.info),
          Effect.runPromise(client.info),
          Effect.runPromise(client.info),
        ]);
        expect(requests.filter((entry) => entry.path === "/v1.43/info")).toHaveLength(1);
        expect(requests.filter((entry) => entry.path === "/v1.44/info")).toHaveLength(3);
      },
    );
  });

  test("clears a cached prefix on a later version-shaped 400", async () => {
    const policy: DaemonPolicy = { apiVersion: "1.43" };
    await withFakeDaemon(policy, async ({ host, requests }) => {
      const client = makeDockerApiClient(host, ctx);
      await Effect.runPromise(client.info);
      expect(peekDockerApiPrefix(dockerApiEndpointKey(host))?.prefix).toBe("/v1.43");
      Object.assign(policy, { minApiVersion: "1.44", apiVersion: "1.52", rejectBelowMin: true });
      await Effect.runPromise(client.info);
      expect(peekDockerApiPrefix(dockerApiEndpointKey(host))?.prefix).toBe("/v1.44");
      expect(requests.map((entry) => entry.path)).toEqual(["/v1.43/info", "/v1.43/info", "/v1.44/info"]);
    });
  });

  test("fails closed when DOCKER_API_VERSION is above the tested maximum", async () => {
    const previous = process.env.DOCKER_API_VERSION;
    process.env.DOCKER_API_VERSION = "1.51";
    try {
      const client = makeDockerApiClient("http://127.0.0.1:9", ctx);
      const failure = await Effect.runPromise(client.info.pipe(Effect.flip));
      expect(isDockerApiVersionError(failure)).toBe(true);
      expect(failure.message).toContain("1.51");
      expect(failure.message).toContain("1.43-1.44");
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "DOCKER_API_VERSION");
      else process.env.DOCKER_API_VERSION = previous;
    }
  });
});
