import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunShellScriptFrontMatterError } from "@lando/sdk/errors";
import { Effect, Result } from "effect";
import { parseScriptFile } from "../src/bun-sh-discovery.ts";
import { parseBunShellScriptFrontMatter } from "../src/bun-sh-frontmatter.ts";
import { parseLandofile } from "../src/parser.ts";

const parse = async (body: readonly string[], newline = "\n") => {
  const root = await mkdtemp(join(tmpdir(), "lando-script-metadata-"));
  const path = join(root, "deploy.bun.sh");
  try {
    await writeFile(
      path,
      ["#!/usr/bin/env bun", "", "# ---", ...body.map((line) => `# ${line}`), "# ---", "echo ok"].join(
        newline,
      ),
    );
    return { path, result: await Effect.runPromise(Effect.result(parseScriptFile(path, "deploy.bun.sh"))) };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("discovers nested declared inputs with standard YAML scalar semantics", async () => {
  // Given
  const body = [
    'description: "Ship # safely" # comment',
    "desc: fallback",
    "summary: last",
    "disabled: false",
    "flags:",
    "  dry-run:",
    "    boolean: true",
    "    default: false",
    "  count:",
    "    default: 2",
    "    choices:",
    '      - "2"',
    '      - "3"',
    "args:",
    "  release:",
    "    required: true",
    "  region:",
    '    default: "it\'s west"',
  ];
  // When
  const { result } = await parse(body, "\r\n");
  // Then
  expect(Result.getOrThrow(result)).toMatchObject({
    summary: "Ship # safely",
    frontMatter: {
      disabled: false,
      flags: { "dry-run": { boolean: true, default: false }, count: { default: 2, choices: ["2", "3"] } },
      args: { release: { required: true }, region: { default: "it's west" } },
    },
  });
});

test.each([
  "disabled: 'false'",
  "service: true",
  "desc: 42",
  "summary: null",
  "flags: false",
  "flags:\n  loud:\n    boolean: 'true'",
  "flags:\n  loud:\n    type: boolean",
  "args:\n  release:\n    order: -1",
  "args:\n  release:\n    required: yes",
  "flags:\n  count:\n    default: 2\n    required: true",
  "flags:\n  dry-run:\n  dry_run:",
  "args:\n  a:\n  b:\n    required: true",
  'description: "unterminated',
  "flags:\n  a:\n    boolean: !unknown true",
  "flags:\n\ta:\n    boolean: true",
  "flags: {loud: true}",
  "descripshun: unknown",
])("rejects invalid or conflicting front matter: %s", async (body) => {
  // Given / When
  const { path, result } = await parse(body.split("\n"));
  // Then
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) {
    expect(result.failure).toBeInstanceOf(BunShellScriptFrontMatterError);
    expect(result.failure).toMatchObject({ path });
  }
});

test("attributes YAML parse errors to the physical script line", async () => {
  // Given / When
  const { path, result } = await parse(["description: valid", "flags: {invalid: true}"]);
  // Then
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) {
    expect(result.failure).toMatchObject({
      path,
      issues: [{ message: expect.stringMatching(/line 5\b/) }],
      cause: { filePath: path, line: 5, column: 10 },
    });
  }
});

test.each([
  "description: first\ndescription: second",
  "description: |\n  block",
  "description: 'it''s west'",
])("uses exactly the shared restricted YAML semantics: %s", async (content) => {
  // Given
  const expected = await Effect.runPromise(
    parseLandofile({ file: "/app/test.bun.sh", cwd: "/app", content }),
  );
  const script = ["# ---", ...content.split("\n").map((line) => `# ${line}`), "# ---", "echo ok"].join("\n");
  // When
  const result = await Effect.runPromise(parseBunShellScriptFrontMatter("/app/test.bun.sh", script));
  // Then
  expect(expected).toEqual(result);
});

test.each(["aliases:\n  - ship", "sources:\n  - src", "engine: bun"])(
  "preserves unsupported top-level classification for %s",
  async (body) => {
    // Given / When
    const { result } = await parse(body.split("\n"));
    // Then
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure._tag).toBe("NotImplementedError");
  },
);
