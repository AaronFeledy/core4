import { expect, test } from "bun:test";
import { compileRecipeSource } from "@lando/sdk/recipes";
import { Result } from "effect";

const source = {
  id: "inputs",
  title: "Inputs",
  description: "Inputs",
  version: "1.0.0",
  config: {},
  postInit: [{ type: "bun", verb: "script", script: "setup.bun.sh" }],
} as const;
const context = { sourceKind: "local", packageName: "example", assets: [] } as const;
const firstDigest = `sha256:${"a".repeat(64)}`;
const secondDigest = `sha256:${"b".repeat(64)}`;

test("includes non-output script digests in identity without publishing script assets", () => {
  // Given
  const before = Result.getOrThrow(
    compileRecipeSource(source, { ...context, inputs: { "postInit.0": firstDigest } }),
  );
  // When
  const after = compileRecipeSource(source, { ...context, inputs: { "postInit.0": secondDigest } });
  // Then
  const manifest = Result.getOrThrow(after);
  expect(manifest.snapshot.identity.contentDigest).not.toBe(before.snapshot.identity.contentDigest);
  expect(manifest.snapshot.assets).toEqual([]);
  expect(manifest.postInit).toEqual(source.postInit);
});

test("canonicalizes input evidence independently of record insertion order", () => {
  // Given
  const before = Result.getOrThrow(
    compileRecipeSource(source, {
      ...context,
      inputs: { "postInit.0": firstDigest, "postInit.1": secondDigest },
    }),
  );
  // When
  const after = compileRecipeSource(source, {
    ...context,
    inputs: { "postInit.1": secondDigest, "postInit.0": firstDigest },
  });
  // Then
  expect(Result.getOrThrow(after).snapshot.identity).toEqual(before.snapshot.identity);
});

test.each(["/host/root/setup.bun.sh", "C:\\host\\setup.bun.sh", ""])(
  "rejects host paths or empty input identifiers %s",
  (id) => {
    // Given
    const inputs = { [id]: firstDigest };
    // When
    const result = compileRecipeSource(source, { ...context, inputs });
    // Then
    expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "source-invalid", path: "context" } });
  },
);
