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
  ServiceConfig,
  ServiceScopedLandofile,
  type ValidationIssuePath,
} from "@lando/sdk/schema";
import type { ServiceType } from "@lando/sdk/services";
import { Effect, Result, Schema } from "effect";
import { readProxyDefaultDomain } from "../config/proxy-default-domain.ts";
import { normalizeAppSlug } from "./naming.ts";
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
  const sites = input.deferredSites.filter((site) => pathHasPrefix(site.path, input.pathPrefix));
  const result = yield* Effect.fromResult(
    consumeSites({
      document: input.value,
      pendingSites: sites,
      context:
        input.selfPort === undefined
          ? input.context
          : { ...input.context, service: { port: input.selfPort } },
      scopes:
        input.selfPort === undefined
          ? PLAN_SERVICE_EXPRESSION_SCOPES
          : [...PLAN_SERVICE_EXPRESSION_SCOPES, "service"],
      renderText: true,
      pathPrefix: input.pathPrefix,
    }),
  );
  return result;
});

export const materializeServicePort = Effect.fnUntraced(function* (input: {
  readonly service: ServiceConfig;
  readonly serviceType: ServiceType;
  readonly sites: DeferredExpressionSites;
  readonly context: ExpressionContext;
  readonly pathPrefix: ValidationIssuePath;
  readonly landofilePath: string;
}) {
  const sites = input.sites.filter((site) =>
    expressionScopeMembers(site.template, "service").members.has("port"),
  );
  const first = sites[0];
  if (first === undefined) return input.service;
  const { port, via, framework, type } = input.service;
  const select = input.serviceType.plannedPort;
  const planned = select?.({
    ...(port === undefined ? {} : { port }),
    ...(via === undefined ? {} : { via }),
    ...(framework === undefined ? {} : { framework }),
    ...(type === undefined ? {} : { type }),
  });
  if (planned === undefined) {
    return yield* Effect.fail(
      new ConfigExpressionError({
        message: `Service type ${input.serviceType.id} declares no planned listen port for service.port in this configuration.`,
        path: first.path,
        source: first.source,
        expression: siteExpression(first, input.service, input.pathPrefix.length),
        filePath: "file" in first.source ? first.source.file : input.landofilePath,
        remediation:
          select === undefined
            ? "Use a literal port or choose a service type that declares a planned listen port."
            : "Choose a configuration with a listener and set port: if needed, or remove the service.port expression.",
      }),
    );
  }
  const { document } = yield* materializeServiceScopeSites({
    ...input,
    value: input.service,
    deferredSites: sites,
    selfPort: planned,
  });
  return yield* Schema.decodeUnknownEffect(Schema.toType(ServiceConfig))(document).pipe(
    mapFailures((cause) =>
      compiledValueError(cause, {
        filePath: input.landofilePath,
        pendingSites: sites,
        pathPrefix: input.pathPrefix,
      }),
    ),
  );
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
): Result.Result<ReadonlySet<string>, ConfigExpressionError> => {
  const references = new Set<string>();
  for (const site of sites) {
    if (!pathHasPrefix(site.path, pathPrefix)) continue;
    const members = expressionScopeMembers(site.template, "services");
    if (!members.analyzable)
      return Result.fail(
        new ConfigExpressionError({
          message: "A services.<name> reference must name the service literally.",
          path: site.path,
          expression: JSON.stringify(site.template),
          filePath,
          remediation: "Write the service name directly, for example services.database.creds.user.",
        }),
      );
    for (const member of members.members) references.add(member);
  }
  return Result.succeed(references);
};

export const orderServicesByCredsReferences = (input: {
  readonly landofile: LandofileShape;
  readonly deferredSites: DeferredExpressionSites;
  readonly landofilePath: string;
}): Result.Result<
  { readonly order: readonly string[]; readonly references: ReadonlyMap<string, ReadonlySet<string>> },
  ConfigExpressionError
> => {
  const names = Object.keys(input.landofile.services ?? {});
  const declared = new Set(names);
  const pending = new Map<string, Set<string>>();
  for (const name of names) {
    const references = referencedServices(["services", name], input.deferredSites, input.landofilePath);
    if (Result.isFailure(references)) return Result.fail(references.failure);
    pending.set(name, new Set([...references.success].filter((reference) => declared.has(reference))));
  }
  const order: string[] = [];
  const resolved = new Set<string>();
  while (order.length < names.length) {
    const next = names.find(
      (name) =>
        !resolved.has(name) && [...(pending.get(name) ?? [])].every((reference) => resolved.has(reference)),
    );
    if (next === undefined) {
      const stuck = names.find((name) => !resolved.has(name)) ?? "";
      return Result.fail(
        new ConfigExpressionError({
          message: `Service connection reference cycle involving ${stuck}.`,
          path: ["services", stuck],
          expression: "services",
          filePath: input.landofilePath,
          remediation: "Break the service connection reference cycle.",
        }),
      );
    }
    order.push(next);
    resolved.add(next);
  }
  return Result.succeed({ order, references: pending });
};
