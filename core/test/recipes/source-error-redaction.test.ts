import { expect, test } from "bun:test";
import { RecipeSourceError } from "@lando/sdk/errors";
import type { SourceSession } from "@lando/source-acquisition";
import { resolveGitRecipeSource } from "../../src/recipes/git-source.ts";
import { resolveNpmRecipeSource } from "../../src/recipes/npm-source.ts";
import { resolveRegistryRecipeSource } from "../../src/recipes/registry-source.ts";
import { resolveTarballRecipeSource } from "../../src/recipes/tarball-source.ts";
import { withRecipeSources } from "../_support/recipe-source-session.ts";

const url = "https://user:password-canary@example.test/source?token=query-canary#fragment-canary";
const cases: readonly {
  readonly name: string;
  readonly resolve: (sources: SourceSession) => Promise<unknown>;
  readonly kind: RecipeSourceError["kind"];
}[] = [
  {
    name: "git ref",
    resolve: (sources) => resolveGitRecipeSource({ sources, url, ref: "--invalid" }),
    kind: "clone-failed",
  },
  {
    name: "archive checksum",
    resolve: (sources) => resolveTarballRecipeSource({ sources, url, checksum: "bad" }),
    kind: "checksum-mismatch",
  },
  {
    name: "npm subpath",
    resolve: (sources) => resolveNpmRecipeSource({ sources, package: "pkg", path: `/${url}` }),
    kind: "subpath-invalid",
  },
  {
    name: "registry failure",
    resolve: (sources) =>
      resolveRegistryRecipeSource({
        sources,
        id: "pkg",
        registryUrl: url,
        registryClient: {
          fetchResolution: async () => {
            throw new Error(`Could not read ${url}`);
          },
        },
      }),
    kind: "registry-failed",
  },
];
test.each(cases)("redacts credentials in $name errors before they reach a renderer", async (input) => {
  await withRecipeSources({}, async ({ session }) => {
    const error: unknown = await input.resolve(session).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(RecipeSourceError);
    if (!(error instanceof RecipeSourceError)) throw error;
    expect(error.kind).toBe(input.kind);
    const text = `${error.message}\n${error.source}\n${error.remediation}`;
    expect(text).not.toContain("password-canary");
    expect(text).not.toContain("query-canary");
    expect(text).not.toContain("fragment-canary");
  });
});
