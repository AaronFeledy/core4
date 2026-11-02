import { LandofileIncludeError } from "@lando/sdk/errors";
import { isPlainRecord, mergeLandofiles } from "@lando/sdk/landofile";
import { Effect, Result } from "effect";
import type { ResolveContext } from "./include-context.ts";
import { attributeIncludeError } from "./include-guard.ts";
import { reserveIncludeSelector } from "./include-selector.ts";
import { classify, parseGitInclude, parseNpmInclude } from "./include-source.ts";
import { getOrigins } from "./pipeline/origins.ts";
import type { AuthoredOrigin } from "./pipeline/prepare.ts";

export const reserveConditionalSelectors = Effect.fnUntraced(function* (
  document: Record<string, unknown>,
  ctx: ResolveContext,
  source: AuthoredOrigin,
) {
  const includes = mergeLandofiles([document]).includes;
  if (!Array.isArray(includes)) return;
  for (const [index, value] of includes.entries()) {
    if (
      !isPlainRecord(value) ||
      !Object.hasOwn(value, "when") ||
      value.kind === "tooling" ||
      typeof value.source !== "string"
    )
      continue;
    if (
      (value.path !== undefined && typeof value.path !== "string") ||
      (value.version !== undefined && typeof value.version !== "string")
    )
      continue;
    if (
      [value.source, value.path, value.version].some(
        (field) => typeof field === "string" && (field.includes("{{") || field.includes("${")),
      )
    )
      continue;
    const entry = {
      source: value.source,
      ...(typeof value.path === "string" ? { path: value.path } : {}),
      ...(typeof value.version === "string" ? { version: value.version } : {}),
    };
    const parsed = Result.try({
      try: () => {
        const kind = classify(entry.source);
        switch (kind) {
          case "git": {
            const value = parseGitInclude(entry);
            return { sourceId: value.sourceId, version: value.ref };
          }
          case "npm": {
            const value = parseNpmInclude(entry);
            return { sourceId: value.sourceId, version: value.requestedVersion };
          }
          case "local":
          case "user":
            return undefined;
          default: {
            const exhaustive: never = kind;
            return exhaustive;
          }
        }
      },
      catch: (cause) => {
        if (cause instanceof LandofileIncludeError) return cause;
        throw cause;
      },
    });
    if (Result.isFailure(parsed) || parsed.success === undefined) continue;
    const request = parsed.success;
    const origin = getOrigins(document)?.children.get("includes")?.children.get(index)?.source ?? {
      ...source,
      path: ["includes", index],
    };
    const reserved = yield* Effect.try({
      try: () => reserveIncludeSelector(ctx.walk.selectors, request),
      catch: (cause) => {
        if (cause instanceof LandofileIncludeError) return attributeIncludeError(cause, origin);
        throw cause;
      },
    }).pipe(Effect.result);
    if (Result.isFailure(reserved)) {
      if (ctx.recorder === undefined) return yield* Effect.fail(reserved.failure);
      ctx.recorder.record(reserved.failure, origin);
      ctx.walk.complete = false;
    }
  }
});
