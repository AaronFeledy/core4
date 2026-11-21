import { compiledValueError, consumeSites, siteExpression } from "@lando/landofile/compiled-sites";
import { provenanceOf } from "@lando/landofile/provenance";
import {
  PLAN_IDENTITY_EXPRESSION_SCOPES,
  PLAN_SERVICE_EXPRESSION_SCOPES,
  recipeOptionScope,
} from "@lando/landofile/recipe-expressions";
import { pathHasPrefix, pathsOverlap } from "@lando/landofile/validation";
import { mapFailures } from "@lando/sdk/command-result";
import { ConfigExpressionError } from "@lando/sdk/errors";
import { type ExpressionContext, expressionScopeMembers } from "@lando/sdk/expressions";
import {
  type AppPlan,
  type CompilationContext,
  type GlobalConfig,
  IdentityScopedLandofile,
  LandofileShape,
  type LoadScopedLandofile,
  type ParsedPendingSite,
  type PortNumber,
  ServiceName,
  ServiceScopedLandofile,
  type ValidationIssuePath,
} from "@lando/sdk/schema";
import type { PluginRegistry } from "@lando/sdk/services";
import { type Context, Effect, Result, Schema } from "effect";
import { readProxyDefaultDomain } from "../config/proxy-default-domain.ts";
import { normalizeAppSlug } from "./naming.ts";
import { ownPortReplacement } from "./self-read-hint.ts";
import { type ServiceExpressionFacts, serviceExpressionFacts } from "./service-credential-facts.ts";

export interface MaterializeLandofileScopesInput {
  readonly landofile: LoadScopedLandofile;
  readonly appRoot: string;
  readonly landofilePath: string;
  readonly globalConfig: Readonly<{ readonly proxy?: GlobalConfig["proxy"] }> | undefined;
}

export type DeferredExpressionSites = readonly ParsedPendingSite[];
export type ServiceCredsScope = Readonly<Record<string, ServiceExpressionFacts>>;
export const pathIsBlocked = (
  blocked: readonly ValidationIssuePath[] | undefined,
  path: ValidationIssuePath,
): boolean => blocked?.some((site) => pathsOverlap(site, path)) ?? false;
export const configExpressionIssuePath = (error: ConfigExpressionError): ValidationIssuePath => error.path;

const decodeDocument = (document: unknown, filePath: string, pendingSites: readonly ParsedPendingSite[]) =>
  Schema.decodeUnknownEffect(Schema.toType(LandofileShape))(document, { onExcessProperty: "error" }).pipe(
    mapFailures((cause) => compiledValueError(cause, { filePath, pendingSites })),
  );

export const materializeLandofileScopes = Effect.fn("Landofile.identityScope")(function* (
  input: MaterializeLandofileScopesInput,
) {
  const compiled = input.landofile;
  const appSlug = normalizeAppSlug(compiled.document.name ?? "app", compiled.context.appRoot);
  const defaultDomain = readProxyDefaultDomain(input.globalConfig ?? {});
  const result = yield* Effect.fromResult(
    consumeSites({
      document: compiled.document,
      pendingSites: compiled.pendingSites,
      scopes: PLAN_IDENTITY_EXPRESSION_SCOPES,
      renderText: true,
      context: {
        app: { name: appSlug, slug: appSlug },
        proxy: { defaultDomain },
        env: compiled.context.env,
        recipe: recipeOptionScope(compiled.document),
      },
    }),
  );
  const document = yield* decodeDocument(result.document, input.landofilePath, compiled.pendingSites);
  const provenance = provenanceOf(compiled);
  const carrier = IdentityScopedLandofile.make({
    ...result,
    document,
    stage: "identity-scoped",
    context: compiled.context,
    provenance,
  });
  return {
    landofile: document,
    provenance,
    compiled: carrier,
    context: carrier.context,
    pendingSites: carrier.pendingSites,
    deferredSites: carrier.pendingSites,
    appSlug,
    defaultDomain,
  };
});

export const serviceScopeContext = (input: {
  readonly landofile: LandofileShape;
  readonly context: CompilationContext;
  readonly appSlug: string;
  readonly defaultDomain: string;
  readonly services: ServiceCredsScope;
}): ExpressionContext => ({
  app: { name: input.appSlug, slug: input.appSlug },
  proxy: { defaultDomain: input.defaultDomain },
  env: input.context.env,
  recipe: recipeOptionScope(input.landofile),
  services: input.services,
});

export const materializeServiceScopeSites = Effect.fn("Landofile.serviceSites")(function* (input: {
  readonly value: unknown;
  readonly landofilePath: string;
  readonly pathPrefix: ValidationIssuePath;
  readonly deferredSites: DeferredExpressionSites;
  readonly context: ExpressionContext;
  readonly selfPort?: PortNumber;
}) {
  const { selfPort, context } = input;
  const hasSelfPort = selfPort !== undefined;
  const sites = input.deferredSites.filter((site) => pathHasPrefix(site.path, input.pathPrefix));
  const result = yield* Effect.fromResult(
    consumeSites({
      document: input.value,
      pendingSites: sites,
      context: hasSelfPort ? { ...context, service: { port: selfPort } } : context,
      scopes: hasSelfPort ? [...PLAN_SERVICE_EXPRESSION_SCOPES, "service"] : PLAN_SERVICE_EXPRESSION_SCOPES,
      renderText: true,
      pathPrefix: input.pathPrefix,
    }),
  );
  return result;
});

export const serviceCredsScopeForPlan = (plan: AppPlan): ServiceCredsScope =>
  Object.fromEntries(
    Object.values(plan.services).flatMap((service) => {
      const facts = serviceExpressionFacts(service);
      return facts === undefined ? [] : [[service.name, facts]];
    }),
  );

/** Replay non-service declarations for tooling, which gets service facts from the plan. */
export const materializeLandofileScopesForPlan = Effect.fn("Landofile.planScopes")(function* (
  input: MaterializeLandofileScopesInput,
  plan: AppPlan,
) {
  const identity = yield* materializeLandofileScopes(input);
  const { services: _services, ...nonServiceDocument } = identity.landofile;
  const result = yield* materializeServiceScopeSites({
    value: nonServiceDocument,
    landofilePath: input.landofilePath,
    pathPrefix: [],
    deferredSites: identity.pendingSites.filter((site) => site.path[0] !== "services"),
    context: serviceScopeContext({ ...identity, services: serviceCredsScopeForPlan(plan) }),
  });
  const document = yield* decodeDocument(result.document, input.landofilePath, identity.pendingSites);
  return ServiceScopedLandofile.make({
    ...result,
    document,
    stage: "service-scoped",
    context: identity.context,
    provenance: identity.provenance,
  });
});

export const referencedServices = (
  pathPrefix: ValidationIssuePath,
  sites: DeferredExpressionSites,
  filePath: string,
): Result.Result<ReadonlyMap<string, ParsedPendingSite>, ConfigExpressionError> => {
  const references = new Map<string, ParsedPendingSite>();
  for (const site of sites) {
    if (!pathHasPrefix(site.path, pathPrefix)) continue;
    const members = expressionScopeMembers(site.template, "services");
    if (!members.analyzable)
      return Result.fail(
        new ConfigExpressionError({
          message: "A services.<name> reference must name the service literally.",
          path: site.path,
          expression: siteExpression(site),
          source: site.source,
          filePath: "file" in site.source ? site.source.file : filePath,
          remediation: "Write the service name directly, for example services.database.creds.user.",
        }),
      );
    for (const member of members.members) if (!references.has(member)) references.set(member, site);
  }
  return Result.succeed(references);
};

export const orderServicesByCredsReferences = Effect.fnUntraced(function* (input: {
  readonly landofile: LandofileShape;
  readonly deferredSites: DeferredExpressionSites;
  readonly landofilePath: string;
  readonly pluginRegistry: Context.Service.Shape<typeof PluginRegistry>;
}) {
  const names = Object.keys(input.landofile.services ?? {});
  const declared = new Set(names);
  const pending = new Map<string, ReadonlyMap<string, ParsedPendingSite>>();
  for (const name of names) {
    const references = yield* Effect.fromResult(
      referencedServices(["services", name], input.deferredSites, input.landofilePath),
    );
    const self = references.get(name);
    if (self !== undefined) {
      const replacement = yield* ownPortReplacement({ ...input, name, site: self });
      return yield* Effect.fail(
        new ConfigExpressionError({
          message: `Service ${name} cannot read its own published facts.`,
          path: self.path,
          source: self.source,
          expression: siteExpression(self, input.landofile.services?.[ServiceName.make(name)], 2),
          filePath: "file" in self.source ? self.source.file : input.landofilePath,
          remediation: replacement
            ? "Use {{ service.port }} for the planned listen port."
            : "Remove the self-reference; a service's published facts are only available after it resolves.",
        }),
      );
    }
    pending.set(name, new Map([...references].filter(([reference]) => declared.has(reference))));
  }
  const order: string[] = [];
  const resolved = new Set<string>();
  while (order.length < names.length) {
    const next = names.find(
      (name) =>
        !resolved.has(name) &&
        [...(pending.get(name)?.keys() ?? [])].every((reference) => resolved.has(reference)),
    );
    if (next === undefined) {
      const chain = new Map<string, ParsedPendingSite>();
      let current = names.find((name) => !resolved.has(name));
      while (current !== undefined && !chain.has(current)) {
        const edge = [...(pending.get(current) ?? [])].find(([reference]) => !resolved.has(reference));
        if (edge === undefined) break;
        chain.set(current, edge[1]);
        current = edge[0];
      }
      const members = [...chain.keys()];
      const first = current === undefined ? undefined : chain.get(current);
      const cycle = current === undefined ? members : members.slice(members.indexOf(current));
      return yield* Effect.fail(
        new ConfigExpressionError({
          message: `Service connection reference cycle involving ${cycle.join(", ")}.`,
          path: first?.path ?? ["services"],
          expression: first === undefined ? "services" : siteExpression(first, input.landofile),
          filePath: first !== undefined && "file" in first.source ? first.source.file : input.landofilePath,
          ...(first === undefined ? {} : { source: first.source }),
          remediation: "Break the service connection reference cycle.",
        }),
      );
    }
    order.push(next);
    resolved.add(next);
  }
  return { order, references: pending };
});
