import { describe, expect, test } from "bun:test";
import { Effect, Either, ParseResult, Schema } from "effect";

import {
  BunShellScriptFrontMatterError,
  LandofileValidationError,
  RecipeManifestValidationError,
  ScratchAppError,
} from "@lando/sdk/errors";
import { BunShellScriptFrontMatter, LandofileShape, RecipeManifest } from "@lando/sdk/schema";

import { decodeOrFail } from "../../src/schema/decode.ts";

const issuesWithMessages = (cause: unknown, fallback: string): ReadonlyArray<string> => {
  if (ParseResult.isParseError(cause)) {
    return ParseResult.ArrayFormatter.formatErrorSync(cause).map((issue) =>
      issue.path.length === 0 ? issue.message : `${issue.path.join(".")}: ${issue.message}`,
    );
  }
  return [cause instanceof Error ? cause.message : fallback];
};

const globalIssues = (cause: unknown): ReadonlyArray<string> => {
  if (ParseResult.isParseError(cause)) {
    return ParseResult.ArrayFormatter.formatErrorSync(cause).map((issue) =>
      issue.path.length === 0 ? issue.message : issue.path.join("."),
    );
  }
  return [cause instanceof Error ? cause.message : "Invalid Landofile."];
};

const legacyDecode = <A, I, E>(
  schema: Schema.Schema<A, I, never>,
  input: unknown,
  onError: (cause: ParseResult.ParseError) => E,
) => {
  const result = Schema.decodeUnknownEither(schema)(input, { onExcessProperty: "error" });
  return Either.isRight(result) ? Effect.succeed(result.right) : Effect.fail(onError(result.left));
};

const errorShape = async <A, E>(effect: Effect.Effect<A, E>) => {
  const error = await Effect.runPromise(Effect.flip(effect));
  const record = error as { readonly _tag?: string; readonly message?: string; readonly issues?: unknown };
  return { _tag: record._tag, message: record.message, issues: record.issues };
};

describe("decodeOrFail", () => {
  test("preserves LandofileService validation error bytes", async () => {
    const input = { name: "app", services: { web: { type: "apache", unsupported: true } } };
    const onError = (cause: ParseResult.ParseError) => {
      const issues = issuesWithMessages(cause, "Invalid Landofile.");
      return new LandofileValidationError({
        message: `Landofile contains unsupported MVP keys: ${issues.join(", ")}. Remove unsupported keys or update the documented Landofile service schema.`,
        file: "/app/.lando.yml",
        issues,
      });
    };

    expect(
      await errorShape(decodeOrFail(LandofileShape, onError)(input, { onExcessProperty: "error" })),
    ).toEqual(await errorShape(legacyDecode(LandofileShape, input, onError)));
  });

  test("preserves Bun shell front-matter validation error bytes", async () => {
    const input = { service: 7, summary: false };
    const onError = (cause: ParseResult.ParseError) =>
      new BunShellScriptFrontMatterError({
        message: ".bun.sh front-matter at /app/.lando/scripts/build.bun.sh is malformed.",
        path: "/app/.lando/scripts/build.bun.sh",
        issues: issuesWithMessages(cause, "Invalid .bun.sh front-matter."),
        remediation: "Use only documented .bun.sh front-matter keys: service and summary.",
      });

    expect(
      await errorShape(
        decodeOrFail(BunShellScriptFrontMatter, onError)(input, { onExcessProperty: "error" }),
      ),
    ).toEqual(await errorShape(legacyDecode(BunShellScriptFrontMatter, input, onError)));
  });

  test("preserves ScratchApp rendered Landofile validation error bytes", async () => {
    const input = { name: "scratch", services: { web: { type: "apache", extra: true } } };
    const onError = (cause: ParseResult.ParseError) =>
      new ScratchAppError({
        message: "The rendered scratch Landofile at /cache/scratch/app/root/.lando.yml is invalid.",
        operation: "materialize",
        cause,
      });

    expect(
      await errorShape(decodeOrFail(LandofileShape, onError)(input, { onExcessProperty: "error" })),
    ).toEqual(await errorShape(legacyDecode(LandofileShape, input, onError)));
  });

  test("preserves RecipeManifest validation error bytes", async () => {
    const input = { name: "empty", services: "nope" };
    const onError = (cause: ParseResult.ParseError) => {
      const issues = issuesWithMessages(cause, "Invalid recipe.yml.");
      return new RecipeManifestValidationError({
        message: `recipe.yml is invalid: ${issues.join(", ")}.`,
        source: "/recipes/empty/recipe.yml",
        issues,
      });
    };

    expect(
      await errorShape(decodeOrFail(RecipeManifest, onError)(input, { onExcessProperty: "error" })),
    ).toEqual(await errorShape(legacyDecode(RecipeManifest, input, onError)));
  });

  test("preserves global Landofile validation error bytes", async () => {
    const input = { name: "global", services: { proxy: { type: "compose", x: true } } };
    const onError = (cause: ParseResult.ParseError) => {
      const issues = globalIssues(cause);
      return new LandofileValidationError({
        message: `Landofile contains unsupported MVP keys: ${issues.join(", ")}. Remove unsupported keys or update the documented Landofile service schema.`,
        file: "/data/global/.lando.dist.yml",
        issues,
      });
    };

    expect(
      await errorShape(decodeOrFail(LandofileShape, onError)(input, { onExcessProperty: "error" })),
    ).toEqual(await errorShape(legacyDecode(LandofileShape, input, onError)));
  });
});
