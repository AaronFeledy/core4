import { describe, expect, test } from "bun:test";

import { Effect } from "effect";
import { makeRuntimeProvider, manifest, plugin } from "../src/index.ts";

const contributionIds = (
  entries: ReadonlyArray<string | { readonly id: string }> | undefined,
): readonly string[] => (entries ?? []).map((entry) => String(typeof entry === "string" ? entry : entry.id));

describe("@lando/provider-docker plugin descriptor", () => {
  test("routes resource inspection through the injected API", async () => {
    // Given
    const paths: string[] = [];
    const provider = await Effect.runPromise(
      makeRuntimeProvider({
        platform: "linux",
        dockerApi: {
          info: Effect.succeed({ Architecture: "x86_64", OSType: "linux" }),
          request: (request) => {
            paths.push(request.path);
            return Effect.succeed({ status: 200, body: '{"Volumes":[{"Name":"legacy"}]}' });
          },
        },
      }),
    );
    // When
    const names = await Effect.runPromise(
      provider.inspectResourceNames?.({ kind: "volume", limit: 4 }) ?? Effect.die("Missing inspector"),
    );
    // Then
    expect(names).toEqual(["legacy"]);
    expect(paths).toEqual(["/volumes?filters=%7B%7D"]);
  });
  test("plugin.name matches manifest.name", () => {
    // Given / When the additive descriptor is exported
    // Then
    expect(plugin.name).toBe(manifest.name);
  });

  test("runtimeProviders keys match manifest.contributes.providers", () => {
    // Given
    const manifestProviderIds = contributionIds(manifest.contributes?.providers);

    // When
    const runtimeProviderIds = [...(plugin.runtimeProviders?.keys() ?? [])].map(String);

    // Then
    expect(runtimeProviderIds).toEqual([...manifestProviderIds]);
  });
});
