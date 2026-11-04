import { describe, expect, test } from "bun:test";
import type { HttpJsonOptions } from "@lando/engine/services/json-fetch";
import { RecipeSourceError } from "@lando/sdk/errors";
import { defaultNpmRegistryClient } from "../../src/recipes/npm-registry-client";
import { parseNpmRegistryConfig } from "../../src/recipes/npm-registry-config";

const token = "literal-default-client-canary-1489";
const registry = "https://npm.example.test/acme/";
const packageName = "@acme/fragments";
const metadata = {
  "dist-tags": { next: "1.2.3", latest: "1.0.0" },
  versions: {
    "1.2.3": { dist: { tarball: "https://npm.example.test/acme/fragments.tgz" } },
    "1.0.0": { dist: { tarball: "https://npm.example.test/acme/fragments-1.0.0.tgz" } },
  },
};
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const config = () =>
  parseNpmRegistryConfig(
    `@acme:registry=${registry}\n//npm.example.test/acme/:_authToken=${token}`,
    {},
    "/home/test/.npmrc",
  );

describe("defaultNpmRegistryClient transport", () => {
  test("exposes registryFor/packument/tarball and resolves scoped registry auth", async () => {
    // Given
    const requests: { url: string; options?: HttpJsonOptions }[] = [];
    const archiveCalls: Array<{
      url: string;
      authorization?: string;
      redactionTokens?: ReadonlyArray<string>;
    }> = [];
    const client = defaultNpmRegistryClient({
      fetchJson: async (url, options) => {
        requests.push({ url, ...(options === undefined ? {} : { options }) });
        return { status: 200, bytes: bytes(metadata) };
      },
      snapshot: async () => config(),
      archive: {
        fetch: async (url, options) => {
          archiveCalls.push({
            url,
            ...(options?.authorization === undefined ? {} : { authorization: options.authorization }),
            ...(options?.redactionTokens === undefined ? {} : { redactionTokens: options.redactionTokens }),
          });
          return new Uint8Array([9, 8, 7]);
        },
      },
    });

    // When
    expect(await client.registryFor(packageName)).toBe(registry);
    const packument = await client.packument(packageName);
    const tarball = await client.tarball({
      packageName,
      dist: metadata.versions["1.2.3"].dist,
    });

    // Then
    expect(packument?.["dist-tags"]?.next).toBe("1.2.3");
    expect(packument?.versions?.["1.2.3"]?.dist).toEqual({
      tarball: "https://npm.example.test/acme/fragments.tgz",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`${registry}@acme%2ffragments`);
    expect(requests[0]?.options?.headers).toEqual([
      { name: "accept", value: "application/json" },
      { name: "authorization", value: `Bearer ${token}` },
    ]);
    expect(tarball).toEqual(new Uint8Array([9, 8, 7]));
    expect(archiveCalls).toHaveLength(1);
    expect(archiveCalls[0]?.url).toBe("https://npm.example.test/acme/fragments.tgz");
    expect(archiveCalls[0]?.authorization).toBe(`Bearer ${token}`);
    expect(archiveCalls[0]?.redactionTokens).toContain(token);
    expect(JSON.stringify(packument)).not.toContain(token);
  });

  test("missing packument version metadata surfaces as registry-failed schema error", async () => {
    // Given
    const client = defaultNpmRegistryClient({
      fetchJson: async () => ({
        status: 200,
        bytes: bytes({
          "dist-tags": { latest: "1.0.0" },
          versions: {
            "1.0.0": { dist: {} },
          },
        }),
      }),
      snapshot: async () => parseNpmRegistryConfig(""),
    });

    // When / Then
    const error = await client.packument("@acme/fragments").catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(RecipeSourceError);
    expect(error).toMatchObject({
      _tag: "RecipeSourceError",
      kind: "registry-failed",
      source: "@acme/fragments",
    });
  });
});
