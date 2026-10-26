import type { ValueOrigins } from "@lando/sdk/landofile";
import { ComposedCompiledLandofile, type ParsedPendingSite } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { finalizeLandofile } from "./pipeline/finalize.ts";
import { rememberOrigins } from "./pipeline/origins.ts";
import { type AuthoredOrigin, prepareOverlay } from "./pipeline/prepare.ts";
import { validationErrorFromCause } from "./validation.ts";

export const loadCompiledLandofile = Effect.fn("Landofile.loadCompiled")(function* (
  input: ComposedCompiledLandofile,
) {
  const file = "<compiled-landofile>";
  const compiled = yield* Schema.decodeUnknownEffect(ComposedCompiledLandofile)(input).pipe(
    Effect.mapError((cause) => validationErrorFromCause(file, input.document, cause)),
  );
  const prepared = yield* prepareOverlay(compiled.document, { file, layer: "canonical" });
  const byPath = new Map(compiled.pendingSites.map((site) => [JSON.stringify(site.path), site]));
  const rebase = (origin: ValueOrigins<AuthoredOrigin>): ValueOrigins<AuthoredOrigin> => {
    const site = byPath.get(JSON.stringify(origin.source.path));
    const source = site?.source;
    return {
      ...origin,
      source:
        source !== undefined &&
        "file" in source &&
        (source.layer === "canonical" ||
          source.layer === "base" ||
          source.layer === "dist" ||
          source.layer === "upstream" ||
          source.layer === "local" ||
          source.layer === "user")
          ? source
          : origin.source,
      children: new Map([...origin.children].map(([key, child]) => [key, rebase(child)])),
    };
  };
  const pendingSites: ParsedPendingSite[] = [...compiled.pendingSites];
  const document = rememberOrigins(prepared.value, rebase(prepared.origins));
  return yield* finalizeLandofile(file, document, {
    appRoot: compiled.context.appRoot,
    env: compiled.context.env,
    pendingSites,
  });
});
