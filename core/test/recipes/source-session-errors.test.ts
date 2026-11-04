import { expect, test } from "bun:test";
import { join } from "node:path";
import { RecipeSourceError } from "@lando/sdk/errors";
import { Effect } from "effect";
import { acquirePluginPackage } from "../../src/cli/commands/plugin-package-acquisition.ts";
import { resolveNpmRecipeSource } from "../../src/recipes/npm-source.ts";
import { withRecipeSources } from "../_support/recipe-source-session.ts";

test.each(["metadata", "download"] as const)("npm %s errors keep their phase", async (phase) => {
  const kind = phase === "metadata" ? "registry-failed" : "download-failed";
  const failure = new RecipeSourceError({
    kind,
    source: "demo",
    message: "network unavailable",
    remediation: "Retry when connected.",
  });
  await withRecipeSources(
    {
      npmRegistry: {
        registryFor: async () => "https://registry.test/",
        packument: async () => {
          if (phase === "metadata") throw failure;
          return {
            "dist-tags": { latest: "1.0.0" },
            versions: {
              "1.0.0": { dist: { tarball: "https://registry.test/archive.tgz", shasum: "a".repeat(40) } },
            },
          };
        },
        tarball: async () => {
          throw failure;
        },
      },
    },
    async ({ root, session }) => {
      await expect(resolveNpmRecipeSource({ package: "demo", sources: session })).rejects.toMatchObject({
        _tag: "RecipeSourceError",
        kind,
      });
      const plugin = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const installScope = yield* Effect.scope;
            return yield* Effect.result(
              acquirePluginPackage({
                options: { spec: "demo", trust: true },
                pluginsRoot: join(root, "plugins"),
                session,
                installScope,
              }),
            );
          }),
        ),
      );
      expect(plugin).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "PluginPackageOperationError",
          operation: phase === "metadata" ? "resolve" : "download",
        },
      });
    },
  );
});
