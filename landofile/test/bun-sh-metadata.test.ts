import { expect, test } from "bun:test";
import { normalizeBunShellScript } from "@lando/landofile/bun-sh-metadata";
import { BunShellScriptFrontMatterError } from "@lando/sdk/errors";
import { type BunShellScriptFrontMatter, ToolingTaskShape } from "@lando/sdk/schema";
import { Result, Schema } from "effect";

const script = (frontMatter: BunShellScriptFrontMatter) => ({
  id: "app:deploy",
  name: "deploy",
  path: "/app/.lando/scripts/deploy.bun.sh",
  relativePath: "deploy.bun.sh",
  service: frontMatter.service ?? ":host",
  summary: frontMatter.description ?? frontMatter.desc ?? frontMatter.summary ?? "",
  frontMatter,
});

test("normalizes script declarations without commands or tooling service references", () => {
  // Given
  const input = script({
    service: ":target",
    desc: "Deploy",
    disabled: true,
    flags: { "dry-run": { boolean: true, default: false }, target: { default: "{{ env.TARGET }}" } },
    args: { release: { required: true }, region: { default: "west" } },
  });
  // When
  const result = Result.getOrThrow(normalizeBunShellScript(input));
  // Then
  expect(result).toMatchObject({
    rawService: ":target",
    summary: "Deploy",
    disabled: true,
    input: {
      flags: [
        { name: "dry-run", boolean: true, default: false },
        { name: "target", default: "{{ env.TARGET }}" },
      ],
      args: [
        { name: "release", order: 0 },
        { name: "region", order: 1, default: "west" },
      ],
    },
    source: { path: input.path, task: "deploy" },
    inputEnvSuffixes: {
      flags: { "dry-run": "DRY_RUN", target: "TARGET" },
      args: { release: "RELEASE", region: "REGION" },
    },
  });
  expect(result).not.toHaveProperty("steps");
  expect(result).not.toHaveProperty("service");
});

test("uses portable environment suffixes independently for flags and arguments", () => {
  // Given
  const input = script({ flags: { "a.é-b": {} }, args: { "a.é-b": {} } });
  // When
  const result = Result.getOrThrow(normalizeBunShellScript(input));
  // Then
  expect(result.inputEnvSuffixes).toEqual({ flags: { "a.é-b": "A___B" }, args: { "a.é-b": "A___B" } });
});

const conflictingMetadata: readonly BunShellScriptFrontMatter[] = [
  { flags: { "dry-run": {}, dry_run: {} } },
  { args: { release: {}, RELEASE: {} } },
  { flags: { a: { alias: "b" }, b: {} } },
  { flags: { a: { required: true, default: "x" } } },
  { flags: { a: { boolean: true, default: "true" } } },
  { flags: { a: { boolean: true, choices: ["x"] } } },
  { flags: { a: { default: "x", choices: ["y"] } } },
  { args: { a: { order: 0 }, b: {} } },
  { args: { a: { order: 0 }, b: { order: 0 } } },
  { args: { a: {}, b: { required: true } } },
  { args: { a: { required: true, default: "x" } } },
];
test.each(conflictingMetadata)("rejects conflicting metadata with script provenance: %j", (frontMatter) => {
  // Given
  const input = script(frontMatter);
  // When
  const result = normalizeBunShellScript(input);
  // Then
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) {
    expect(result.failure).toBeInstanceOf(BunShellScriptFrontMatterError);
    expect(result.failure.path).toBe(input.path);
  }
});

test("preserves explicit positional ordering from shared tooling semantics", () => {
  // Given
  const frontMatter = Schema.decodeUnknownSync(ToolingTaskShape)({
    args: { last: { order: 2 }, first: { order: 1 } },
  });
  // When
  const result = Result.getOrThrow(normalizeBunShellScript(script(frontMatter)));
  // Then
  expect(result.input.args.map((arg) => arg.name)).toEqual(["first", "last"]);
});
