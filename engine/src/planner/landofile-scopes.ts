import { compiledValueError, consumeSites } from "@lando/landofile/compiled-sites";
import { copyLandofileProvenance } from "@lando/landofile/copy-provenance";
import {
  PLAN_IDENTITY_EXPRESSION_SCOPES,
  PLAN_SERVICE_EXPRESSION_SCOPES,
  recipeOptionScope,
} from "@lando/landofile/recipe-expressions";
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
  type ServiceConnection,
  ServiceScopedLandofile,
  type ValidationIssuePath,
} from "@lando/sdk/schema";
import { Effect, Result, Schema } from "effect";
import { readProxyDefaultDomain } from "../config/proxy-default-domain.ts";
import { normalizeAppSlug } from "./naming.ts";

export interface MaterializeLandofileScopesInput {
  readonly landofile: LoadScopedLandofile;
  readonly appRoot: string;
  readonly landofilePath: string;
  readonly globalConfig: Readonly<{ readonly proxy?: GlobalConfig["proxy"] }> | undefined;
}

export type DeferredExpressionSites = readonly ParsedPendingSite[];
export type ServiceCredsScope = Readonly<Record<string, Pick<ServiceConnection, "creds" | "port">>>;
export const deferredSiteKey = (path: ValidationIssuePath): string => path.join(".");
export const configExpressionIssuePath = (error: ConfigExpressionError): ValidationIssuePath =>
  error.path.length === 0
    ? []
    : error.path.split(".").map((part) => (/^(?:0|[1-9][0-9]*)$/.test(part) ? Number(part) : part));

const decodeDocument = (document: unknown, filePath: string, pendingSites: readonly ParsedPendingSite[]) =>
  Schema.decodeUnknownEffect(Schema.toType(LandofileShape))(document, { onExcessProperty: "error" }).pipe(
    Effect.mapError((cause) => compiledValueError(cause, { filePath, pendingSites })),
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
      context: {
        app: { name: appSlug, slug: appSlug },
        proxy: { defaultDomain },
        env: compiled.context.env,
        recipe: recipeOptionScope(compiled.document),
      },
    }),
  );
  const document = copyLandofileProvenance(
    compiled.document,
    yield* decodeDocument(result.document, input.landofilePath, compiled.pendingSites),
  );
  const carrier = IdentityScopedLandofile.make({
    ...result,
    document,
    stage: "identity-scoped",
    context: compiled.context,
  });
  copyLandofileProvenance(document, carrier.document);
  return {
    landofile: document,
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
}) {
  const sites = input.deferredSites.filter((site) =>
    input.pathPrefix.every((key, index) => site.path[index] === key),
  );
  const result = yield* Effect.fromResult(
    consumeSites({
      document: input.value,
      pendingSites: sites,
      context: input.context,
      scopes: PLAN_SERVICE_EXPRESSION_SCOPES,
      pathPrefix: input.pathPrefix,
    }),
  );
  return result;
});

export const serviceCredsScopeForPlan = (plan: AppPlan): ServiceCredsScope =>
  Object.fromEntries(
    Object.values(plan.services).flatMap((service) =>
      service.connection === undefined
        ? []
        : [[service.name, { creds: service.connection.creds, port: service.connection.port }]],
    ),
  );

export const materializeLandofileScopesForPlan = Effect.fn("Landofile.planScopes")(function* (
  input: MaterializeLandofileScopesInput,
  plan: AppPlan,
) {
  const identity = yield* materializeLandofileScopes(input);
  const result = yield* materializeServiceScopeSites({
    value: identity.landofile,
    landofilePath: input.landofilePath,
    pathPrefix: [],
    deferredSites: identity.pendingSites,
    context: serviceScopeContext({ ...identity, services: serviceCredsScopeForPlan(plan) }),
  });
  const document = yield* decodeDocument(result.document, input.landofilePath, identity.pendingSites);
  return ServiceScopedLandofile.make({
    ...result,
    document,
    stage: "service-scoped",
    context: identity.context,
  });
});

export const referencedServices = (
  pathPrefix: ValidationIssuePath,
  sites: DeferredExpressionSites,
  filePath: string,
): Result.Result<ReadonlySet<string>, ConfigExpressionError> => {
  const references = new Set<string>();
  for (const site of sites) {
    if (!pathPrefix.every((key, index) => site.path[index] === key)) continue;
    const members = expressionScopeMembers(site.template, "services");
    if (!members.analyzable)
      return Result.fail(
        new ConfigExpressionError({
          message: "A services.<name> reference must name the service literally.",
          path: deferredSiteKey(site.path),
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
          path: `services.${stuck}`,
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
