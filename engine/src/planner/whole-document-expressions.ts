import { compiledValueError } from "@lando/landofile/compiled-sites";
import { mapFailures } from "@lando/sdk/command-result";
import type { ExpressionContext } from "@lando/sdk/expressions";
import { LandofileShape, type ParsedPendingSite, type ValidationIssuePath } from "@lando/sdk/schema";
import { Effect, Result, Schema } from "effect";
import { materializeServiceScopeSites, referencedServices } from "./landofile-scopes.ts";
import type { PlannerIssue } from "./resolved-validation.ts";
import type { resolveServiceSeeds } from "./service-seeds.ts";

export const pendingAfterSeeds = (
  seeds: Effect.Success<ReturnType<typeof resolveServiceSeeds>>,
  landofilePath: string,
) => {
  const blocked: ParsedPendingSite[] = [];
  const available: ParsedPendingSite[] = [];
  const dependentSkips: { readonly path: ValidationIssuePath; readonly cause: PlannerIssue }[] = [];
  for (const [name, cause] of seeds.skippedServices) dependentSkips.push({ path: ["services", name], cause });
  for (const site of seeds.pendingSites) {
    if (seeds.unavailable.size === 0) {
      available.push(site);
      continue;
    }
    const [section, name] = site.path;
    if (section === "services" && typeof name === "string" && seeds.unavailable.has(name)) {
      blocked.push(site);
      continue;
    }
    const references = referencedServices([], [site], landofilePath);
    if (Result.isFailure(references)) {
      blocked.push(site);
      continue;
    }
    const unavailable = [...references.success.keys()].flatMap((name) => seeds.unavailable.get(name) ?? []);
    if (unavailable.length === 0) {
      available.push(site);
      continue;
    }
    blocked.push(site);
    const cause = unavailable.find(({ rule }) => rule === "landofile.expression");
    if (cause !== undefined) dependentSkips.push({ path: site.path, cause });
  }
  return { blocked, available, dependentSkips };
};

export const materializeWholeDocument = Effect.fnUntraced(function* (input: {
  readonly landofile: LandofileShape;
  readonly landofilePath: string;
  readonly pendingSites: readonly ParsedPendingSite[];
  readonly context: ExpressionContext;
}) {
  const { landofile, pendingSites, landofilePath, context } = input;
  if (pendingSites.length === 0) return { document: landofile, pendingSites };
  const scoped = yield* materializeServiceScopeSites({
    value: landofile,
    landofilePath,
    pathPrefix: [],
    deferredSites: pendingSites,
    context,
  });
  const document = yield* Schema.decodeUnknownEffect(Schema.toType(LandofileShape))(scoped.document).pipe(
    mapFailures((cause) => compiledValueError(cause, { filePath: landofilePath, pendingSites })),
  );
  return { document, pendingSites: scoped.pendingSites };
});
