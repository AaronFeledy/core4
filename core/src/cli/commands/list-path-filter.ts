import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { isPathWithin, resolveHostHome } from "@lando/paths";
import { Context, Effect, Layer } from "effect";

export const isPathLikeFilter = (filter: string): boolean =>
  filter === "." || filter === ".." || filter.startsWith("~") || /[/\\]/u.test(filter);

export class AppsListPathResolver extends Context.Service<
  AppsListPathResolver,
  {
    readonly canonicalize: (path: string) => Effect.Effect<string | undefined>;
  }
>()("@lando/core/AppsListPathResolver") {
  static readonly layer = Layer.succeed(this, {
    canonicalize: Effect.fn("AppsListPathResolver.canonicalize")((path: string) =>
      Effect.tryPromise(() => realpath(path)).pipe(Effect.catch(() => Effect.succeed(undefined))),
    ),
  });
}

export const filterAppsByPath = Effect.fnUntraced(function* <A extends { readonly appRoot: string }>(
  apps: ReadonlyArray<A>,
  filter: string,
  cwd: string,
) {
  if (!isPathLikeFilter(filter)) return apps.filter((app) => app.appRoot.includes(filter));
  const resolver = yield* AppsListPathResolver;
  const expanded =
    filter === "~"
      ? resolveHostHome()
      : /^~[/\\]/u.test(filter)
        ? resolve(resolveHostHome(), filter.slice(2))
        : filter;
  const target = yield* resolver.canonicalize(resolve(cwd, expanded));
  if (target === undefined) return apps.filter((app) => app.appRoot.includes(filter));
  const matches = yield* Effect.forEach(apps, (app) =>
    Effect.gen(function* () {
      if (app.appRoot === "") return false;
      // Saved roots can predate canonicalization or retain a symlink spelling.
      const root = (yield* resolver.canonicalize(app.appRoot)) ?? resolve(app.appRoot);
      return isPathWithin(target, root);
    }),
  );
  return apps.filter((_app, index) => matches[index]);
});
