import { LandofileIncludeError, LandofileLockMismatchError, causeMessage } from "@lando/sdk/errors";
import type { IncludeEntry } from "@lando/sdk/schema";
import { Effect, Exit } from "effect";
import type { ResolveContext } from "./include-context.ts";
import { parseFragment } from "./include-fragment.ts";
import { hasIncludeCycle } from "./include-graph.ts";
import { attributeIncludeError, includeError } from "./include-guard.ts";
import { fetchLocal, fetchUser } from "./include-local.ts";
import { stageFragmentLock } from "./include-lockfile.ts";
import { fetchRemoteRelative } from "./include-remote-relative.ts";
import { fetchGit, fetchNpm } from "./include-remote.ts";
import { classify, normalizeInclude } from "./include-source.ts";
import type { AuthoredOrigin } from "./pipeline/prepare.ts";

export const acquireIncludeRequest = Effect.fnUntraced(
  function* (
    request: { readonly entry: IncludeEntry; readonly origin: AuthoredOrigin; readonly source: string },
    ctx: ResolveContext,
  ) {
    const entry = normalizeInclude(request.entry);
    const kind = classify(entry.source);
    if (ctx.lockAvailable === false && (kind === "git" || kind === "npm")) return;
    const fragment = yield* Effect.tryPromise({
      try: async () => {
        if (ctx.userOwned && (kind === "git" || kind === "npm"))
          throw includeError({
            message: `User Landofile profile ${request.source} must not declare remote include ${entry.source}.`,
            source: entry.source,
            kind: "source-unresolved",
            remediation: "Use relative or user: YAML includes inside the user includes directory.",
          });
        switch (kind) {
          case "local":
            return ctx.remoteOrigin === undefined ? fetchLocal(entry, ctx) : fetchRemoteRelative(entry, ctx);
          case "user":
            return fetchUser(entry, ctx);
          case "git":
            return fetchGit(entry, ctx);
          case "npm":
            return fetchNpm(entry, ctx);
          default: {
            const exhaustive: never = kind;
            return exhaustive;
          }
        }
      },
      catch: (cause) =>
        cause instanceof LandofileIncludeError || cause instanceof LandofileLockMismatchError
          ? cause
          : includeError({ message: causeMessage(cause), source: entry.source, kind: "fetch-failed" }),
    });
    if (fragment === undefined) return;
    yield* stageFragmentLock(fragment, ctx);
    if (hasIncludeCycle(ctx.ancestors ?? [], fragment.sourceId))
      return yield* Effect.fail(
        includeError({
          message: `Landofile include cycle detected at ${entry.source}.`,
          source: entry.source,
          kind: "cycle",
        }),
      );
    let fragmentKind: "compose" | "landofile" | "tooling" = "landofile";
    if (request.origin.path[0] === "include") fragmentKind = "compose";
    else if (typeof request.entry !== "string") fragmentKind = request.entry.kind ?? "landofile";
    const parsed = yield* parseFragment(
      {
        ...fragment,
        kind: fragmentKind,
      },
      ctx,
      request.origin.layer,
    );
    return { fragment, parsed };
  },
  (effect, request) => effect.pipe(Effect.mapError((error) => attributeIncludeError(error, request.origin))),
  (effect, request, ctx) =>
    ctx.observeInclude === undefined
      ? effect
      : effect.pipe(
          Effect.onExit(
            (exit) =>
              ctx.observeInclude?.(request, Exit.isSuccess(exit) ? exit.value : undefined, ctx) ??
              Effect.void,
          ),
        ),
);
