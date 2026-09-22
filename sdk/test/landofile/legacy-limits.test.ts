import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";

import { parseLegacyLandofile } from "@lando/sdk/landofile";

const FILE = "/app/.lando.yml";

const parse = (
  content: string,
  limits?: { maxContentBytes?: number; maxDepth?: number; maxAliases?: number },
) =>
  Effect.runSync(
    Effect.exit(parseLegacyLandofile({ mode: "legacy", file: FILE, content, ...(limits ? { limits } : {}) })),
  );

const failureOf = (
  exit: Exit.Exit<unknown, { readonly message: string; readonly line?: number | undefined }>,
) => {
  if (Exit.isSuccess(exit)) throw new Error("expected a parse failure");
  const failure = Exit.causeOption(exit);
  if (failure._tag === "None") throw new Error("expected a failure cause");
  const error = failure.value;
  if (error._tag !== "Fail") throw new Error(`expected a typed failure, got ${error._tag}`);
  return error.error;
};

const aliasDocument = (count: number): string => {
  const uses = Array.from({ length: count }, (_, index) => `  use${index}: *base`).join("\n");
  return `base: &base value\nservices:\n${uses}\n`;
};

const nested = (depth: number): string => {
  let content = "";
  for (let level = 0; level < depth; level += 1) content += `${" ".repeat(level * 2)}k${level}:\n`;
  return `${content}${" ".repeat(depth * 2)}leaf: value\n`;
};

describe("legacy parse limits", () => {
  test("accepts the alias count at the bound and rejects the occurrence beyond it", () => {
    expect(Exit.isSuccess(parse(aliasDocument(3), { maxAliases: 3 }))).toBe(true);

    const error = failureOf(parse(aliasDocument(4), { maxAliases: 3 }));
    expect(error.message).toContain("4");
    expect(error.message).toContain("3");
  });

  test("accepts content at the byte cap and rejects one byte past it", () => {
    const content = "name: app\n";
    const bytes = Buffer.byteLength(content, "utf8");

    expect(Exit.isSuccess(parse(content, { maxContentBytes: bytes }))).toBe(true);
    expect(failureOf(parse(content, { maxContentBytes: bytes - 1 })).message).toContain(
      "exceeds the maximum input size",
    );
  });

  test("accepts nesting at the depth bound and rejects one level past it", () => {
    expect(Exit.isSuccess(parse(nested(4), { maxDepth: 8 }))).toBe(true);
    expect(failureOf(parse(nested(6), { maxDepth: 3 })).message).toContain("depth");
  });

  test("parses a long single-line flow sequence in linear time", () => {
    const content = `items: [${"1,".repeat(20000)}1]\n`;
    const started = performance.now();
    expect(Exit.isSuccess(parse(content))).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("rejects a duplicate mapping key naming both lines", () => {
    const error = failureOf(parse("services:\n  web:\n    type: php\nservices:\n  db:\n    type: mysql\n"));

    expect(error.message).toContain("services");
    expect(error.line).toBe(4);
  });
});
