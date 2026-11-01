import { describe, expect, test } from "bun:test";
import type { HttpJsonOptions } from "@lando/engine/services/json-fetch";
import { DownloadFetchError, RecipeSourceError } from "@lando/sdk/errors";
import { loadNpmRegistryConfig, parseNpmRegistryConfig } from "../../src/recipes/npm-registry-config";
import { defaultNpmRegistryClient, makeNpmRecipeSourcePort } from "../../src/recipes/npm-source";

const token = "literal-not-an-environment-secret-1489";
const registry = "https://npm.example.test/acme/";
const packageName = "@acme/plugin";
const metadata = {
  "dist-tags": { latest: "1.0.0" },
  versions: {
    "1.0.0": {
      dist: { tarball: "https://npm.example.test/download/plugin.tgz" },
      landoPlugin: { name: packageName },
    },
  },
};
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const config = () =>
  parseNpmRegistryConfig(
    `@acme:registry=${registry}\n//npm.example.test/acme/:_authToken=${token}`,
    {},
    "/home/test/.npmrc",
  );

describe("npm registry requests", () => {
  test("rejects a tarball without its acquisition context instead of silently dropping auth", async () => {
    const port = makeNpmRecipeSourcePort(
      defaultNpmRegistryClient(
        undefined,
        async () => ({ status: 200, bytes: bytes(metadata) }),
        async () => config(),
      ),
    );
    const resolved = await port.resolve(packageName);
    await expect(port.fetchTarball({ ...resolved })).rejects.toMatchObject({ kind: "registry-failed" });
  });

  test("shares one lazy user-config snapshot across metadata and credential-aware tarball requests", async () => {
    const reads: string[] = [];
    let snapshot: ReturnType<typeof loadNpmRegistryConfig> | undefined;
    const load = () => {
      snapshot ??= loadNpmRegistryConfig({
        env: {},
        home: "/home/test",
        readFile: async (path) => {
          reads.push(path);
          return `@acme:registry=${registry}\n//npm.example.test/acme/:_authToken=${token}`;
        },
      });
      return snapshot;
    };
    const requests: { url: string; options?: HttpJsonOptions }[] = [];
    const client = defaultNpmRegistryClient(
      undefined,
      async (url, options) => {
        requests.push({ url, ...(options === undefined ? {} : { options }) });
        return { status: 200, bytes: bytes(metadata) };
      },
      load,
    );
    expect(reads).toEqual([]);
    const port = makeNpmRecipeSourcePort(client, undefined, {
      fetch: async (url, options) => {
        expect(url).toBe(metadata.versions["1.0.0"].dist.tarball);
        expect(options?.authorization).toBe(`Bearer ${token}`);
        expect(options?.redactionTokens).toContain(token);
        return new Uint8Array([1, 2]);
      },
    });
    const resolved = await port.resolve(packageName);
    const archive = await port.fetchTarball(resolved);
    expect(archive).toEqual(new Uint8Array([1, 2]));
    expect(requests[0]?.url).toBe(`${registry}@acme%2fplugin`);
    expect(requests[0]?.options?.headers).toEqual([
      { name: "accept", value: "application/json" },
      { name: "authorization", value: `Bearer ${token}` },
    ]);
    expect(requests[0]?.options?.redactionTokens).toContain(token);
    expect(reads).toEqual(["/home/test/.npmrc"]);
    expect(JSON.stringify(resolved)).not.toContain(token);
  });

  test.each([401, 403, 404])("provides safe npmrc remediation for HTTP %i", async (status) => {
    const client = defaultNpmRegistryClient(
      undefined,
      async () => ({ status, bytes: bytes({ error: token }) }),
      async () => config(),
    );
    const error = await client.fetchPackument(packageName).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(RecipeSourceError);
    expect(JSON.stringify(error)).not.toContain(token);
    if (!(error instanceof RecipeSourceError)) throw new Error("Expected registry failure");
    expect(error.kind).toBe(status === 404 ? "package-not-found" : "auth");
    if (status !== 404) {
      expect(error.remediation).toContain("/home/test/.npmrc");
      expect(error.remediation).toContain("rejected the //npm.example.test/acme/:_authToken token");
    }
  });

  test("explains private-package 404s without configured auth", async () => {
    const client = defaultNpmRegistryClient(
      registry,
      async () => ({ status: 404, bytes: new Uint8Array() }),
      async () => parseNpmRegistryConfig(""),
    );
    await expect(client.fetchPackument(packageName)).rejects.toMatchObject({
      kind: "package-not-found",
      remediation: expect.stringContaining("Private packages need a token"),
    });
  });

  test.each(["transport", "json", "schema", "tarball"] as const)(
    "does not expose literal tokens in %s failures",
    async (failure) => {
      const client = defaultNpmRegistryClient(
        undefined,
        async () => {
          if (failure === "transport") throw new Error(`connection failed: ${token}`);
          return {
            status: 200,
            bytes:
              failure === "json"
                ? new TextEncoder().encode(`invalid ${token}`)
                : bytes({ versions: { "1.0.0": token } }),
          };
        },
        async () => config(),
      );
      const request =
        failure === "tarball"
          ? client.fetchTarball?.(
              { packageName, dist: metadata.versions["1.0.0"].dist },
              {
                fetch: async () => {
                  throw new Error(token);
                },
              },
            )
          : client.fetchPackument(packageName);
      if (request === undefined) throw new Error("Expected tarball method");
      const error = await request.catch((error: unknown) => error);
      expect(error).toBeInstanceOf(RecipeSourceError);
      expect(String(error)).not.toContain(token);
      expect(JSON.stringify(error)).not.toContain(token);
    },
  );

  test.each([
    [401, "auth"],
    [403, "auth"],
    [500, "download-failed"],
  ] as const)("classifies tarball HTTP %i as %s without exposing tokens", async (status, kind) => {
    const client = defaultNpmRegistryClient(
      undefined,
      async () => ({ status: 200, bytes: bytes(metadata) }),
      async () => config(),
    );
    const fetchTarball = client.fetchTarball;
    if (fetchTarball === undefined) throw new Error("Expected tarball method");

    const error = await fetchTarball(
      { packageName, dist: metadata.versions["1.0.0"].dist },
      {
        fetch: async () => {
          throw new DownloadFetchError({
            message: `Rejected ${token}`,
            urlOrigin: "https://npm.example.test",
            status,
            remediation: "Retry the download.",
          });
        },
      },
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(RecipeSourceError);
    expect(error).toMatchObject({ kind, source: packageName });
    expect(JSON.stringify(error)).not.toContain(token);
  });

  test("starts a fresh lazy config snapshot for each retained include resolution", async () => {
    let count = 0;
    const port = makeNpmRecipeSourcePort(() => {
      count++;
      return defaultNpmRegistryClient(
        undefined,
        async () => ({ status: 200, bytes: bytes(metadata) }),
        async () => config(),
      );
    });
    expect(count).toBe(0);
    await port.resolve(packageName);
    await port.resolve(packageName);
    expect(count).toBe(2);
  });
});
