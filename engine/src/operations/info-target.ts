import { AbsolutePath, normalizeAppSlug } from "@lando/sdk/schema";
import { LandofileService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect } from "effect";
import { loadUserLandofile, userAppRef } from "../landofile/app-resolution.ts";
import { resolveAppliedStateTarget, validateResolvedAppTarget } from "./applied-state-target.ts";

export const resolveInfoTarget = resolveAppliedStateTarget.pipe(
  Effect.catchTag("AppResolveError", (error) => {
    if (error.reason !== "ambiguous") return Effect.fail(error);
    return Effect.gen(function* () {
      const registry = yield* RuntimeProviderRegistry;
      const landofile = yield* loadUserLandofile(yield* LandofileService).pipe(
        Effect.catch(() => Effect.fail(error)),
      );
      const root = AbsolutePath.make(landofile.context.appRoot);
      const plan = yield* registry.resolveAppliedPlan(root, {
        kind: "user",
        id: normalizeAppSlug(landofile.document.name ?? "app", root),
      });
      if (plan === undefined) return undefined;
      return yield* validateResolvedAppTarget({ plan, root: plan.root, app: userAppRef(plan), landofile });
    });
  }),
);
