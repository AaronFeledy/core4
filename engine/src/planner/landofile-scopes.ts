import { Effect, Result } from "effect";

import { copyLandofileProvenance } from "@lando/landofile/copy-provenance";
import {
  PLAN_IDENTITY_EXPRESSION_SCOPES,
  PLAN_SERVICE_EXPRESSION_SCOPES,
  hostExpressionEnvironment,
  materializeExpressionScopes,
  recipeOptionScope,
} from "@lando/landofile/recipe-expressions";
import { ConfigExpressionError } from "@lando/sdk/errors";
import {
  type ExpressionContext,
  expressionScopeMembers,
  parseExpressionEither,
} from "@lando/sdk/expressions";
import type {
  AppPlan,
  GlobalConfig,
  LandofileShape,
  ServiceCreds,
  ValidationIssuePath,
} from "@lando/sdk/schema";

import { readProxyDefaultDomain } from "../config/proxy-default-domain.ts";
import { normalizeAppSlug } from "./naming.ts";

export interface MaterializeLandofileScopesInput {
  readonly landofile: LandofileShape;
  readonly appRoot: string;
  readonly landofilePath: string;
  readonly globalConfig: Readonly<{ readonly proxy?: GlobalConfig["proxy"] }> | undefined;
}

/**
 * Expressions and paths of the value sites a pass left for a later one.
 *
 * A later pass evaluates only these sites, so a value an earlier pass produced
 * (an `env.*` read that happened to yield `{{ ... }}` text, say) is data, not
 * an expression.
 */
export type DeferredExpressionSites = ReturnType<typeof materializeExpressionScopes>["deferred"];

export interface MaterializedLandofileScopes {
  /** The Landofile with every identity-scope expression replaced by its value. */
  readonly landofile: LandofileShape;
  readonly appSlug: string;
  readonly defaultDomain: string;
  /** Sites that read `services.<name>.*` and wait for service resolution. */
  readonly deferredSites: DeferredExpressionSites;
}

const ARRAY_INDEX_SEGMENT = /^(?:0|[1-9][0-9]*)$/;

export const deferredSiteKey = (path: ReadonlyArray<string | number>): string => path.join(".");

/**
 * Recover the structured issue path from a {@link ConfigExpressionError}
 * raised by one of the planner materialization passes.
 *
 * The error carries the path as dotted text; array positions were written as
 * decimal indexes, so they come back as numbers the way `ValidationIssuePath`
 * documents them.
 */
export const configExpressionIssuePath = (error: ConfigExpressionError): ValidationIssuePath =>
  error.path.length === 0
    ? []
    : error.path.split(".").map((segment) => (ARRAY_INDEX_SEGMENT.test(segment) ? Number(segment) : segment));

const unresolvedExpressionError = (
  unresolved: { readonly path: ValidationIssuePath; readonly expression: string; readonly reason: string },
  landofilePath: string,
  remediation: string,
): ConfigExpressionError =>
  new ConfigExpressionError({
    message: unresolved.reason,
    expression: unresolved.expression,
    path: deferredSiteKey(unresolved.path),
    filePath: landofilePath,
    remediation,
  });

/**
 * Resolve the expression scopes the loader deferred to the planner that do
 * not depend on any service: `app`, `proxy`, `recipe`, and `env`.
 *
 * The loader leaves `app` and `proxy` sites (and any site mixing them with
 * `recipe`/`env`) untouched because only the planner knows the app slug and
 * the proxy default domain. This pass evaluates those sites across the whole
 * document so service configuration, environment, and tooling see the same
 * values route hostnames do. `app.name` is the normalized slug, matching the
 * route-hostname pass. A document with no deferred sites is returned as-is so
 * object identity and provenance are untouched on the common path.
 *
 * Sites that read `services.<name>.creds.*` are reported as deferred: those
 * values exist only once a service type has resolved, so
 * {@link materializeServiceScopeSites} evaluates them later, service by
 * service and then across the rest of the document.
 */
export const materializeLandofileScopes = (
  input: MaterializeLandofileScopesInput,
): Effect.Effect<MaterializedLandofileScopes, ConfigExpressionError> => {
  const appSlug = normalizeAppSlug(input.landofile.name ?? "app", input.appRoot);
  const defaultDomain = readProxyDefaultDomain(input.globalConfig ?? {});
  const materialized = materializeExpressionScopes(input.landofile, input.landofilePath, {
    scopes: PLAN_IDENTITY_EXPRESSION_SCOPES,
    context: {
      app: { name: appSlug, slug: appSlug },
      proxy: { defaultDomain },
      env: hostExpressionEnvironment(),
      recipe: recipeOptionScope(input.landofile),
    },
  });
  const unresolved = materialized.unresolved[0];
  if (unresolved !== undefined) {
    return Effect.fail(
      unresolvedExpressionError(
        unresolved,
        input.landofilePath,
        "Fix the Landofile expression or provide the referenced app, proxy, recipe, or environment value.",
      ),
    );
  }
  if (materialized.value !== input.landofile) {
    copyLandofileProvenance(input.landofile, materialized.value);
  }
  return Effect.succeed({
    landofile: materialized.value,
    appSlug,
    defaultDomain,
    deferredSites: materialized.deferred,
  });
};

/**
 * What `services.<name>` exposes to expressions: the credentials a service
 * type published while resolving, or nothing for a type that publishes none.
 * Only `creds` is exposed; it is the one value a service type publishes that
 * another service legitimately needs at plan time.
 */
export type ServiceCredsScope = Readonly<Record<string, { readonly creds?: ServiceCreds }>>;

const SERVICE_SCOPE_REMEDIATION =
  "Reference a service declared in this Landofile whose type publishes credentials, using services.<name>.creds.user, .password, .database, or .rootPassword.";

export interface ServiceScopeContextInput {
  readonly landofile: LandofileShape;
  readonly appSlug: string;
  readonly defaultDomain: string;
  readonly services: ServiceCredsScope;
}

export const serviceScopeContext = (input: ServiceScopeContextInput): ExpressionContext => ({
  app: { name: input.appSlug, slug: input.appSlug },
  proxy: { defaultDomain: input.defaultDomain },
  env: hostExpressionEnvironment(),
  recipe: recipeOptionScope(input.landofile),
  services: input.services,
});

export interface MaterializeServiceScopeSitesInput<T extends object> {
  readonly value: T;
  readonly landofilePath: string;
  /** Where `value` sits in the Landofile, so deferred-site keys and error paths line up. */
  readonly pathPrefix: ReadonlyArray<string | number>;
  readonly deferredSites: DeferredExpressionSites;
  readonly context: ExpressionContext;
}

/**
 * Evaluate the deferred `services.<name>.creds.*` sites under one value.
 *
 * Only sites the identity pass deferred are touched, so a string that pass
 * produced is never re-read as an expression. A reference to a service that
 * does not exist, or to one whose type published no credentials, fails at the
 * value site. The value keeps its identity when nothing under it changes.
 */
export const materializeServiceScopeSites = <T extends object>(
  input: MaterializeServiceScopeSitesInput<T>,
): Effect.Effect<T, ConfigExpressionError> => {
  const eligibleSites = new Set(input.deferredSites.map((site) => deferredSiteKey(site.path)));
  const materialized = materializeExpressionScopes(input.value, input.landofilePath, {
    scopes: PLAN_SERVICE_EXPRESSION_SCOPES,
    context: input.context,
    eligible: (_value, path) => eligibleSites.has(deferredSiteKey([...input.pathPrefix, ...path])),
  });
  const unresolved = materialized.unresolved[0];
  if (unresolved !== undefined) {
    return Effect.fail(
      unresolvedExpressionError(
        { ...unresolved, path: [...input.pathPrefix, ...unresolved.path] },
        input.landofilePath,
        SERVICE_SCOPE_REMEDIATION,
      ),
    );
  }
  return Effect.succeed(materialized.value);
};

/**
 * The services whose credentials the deferred sites under `services.<name>`
 * read. A computed member (`services[app.name]`) cannot be ordered ahead of
 * time, so it fails at the first such site.
 */
const referencedServices = (
  name: string,
  deferredSites: DeferredExpressionSites,
  landofilePath: string,
): Result.Result<ReadonlySet<string>, ConfigExpressionError> => {
  const prefix = `${deferredSiteKey(["services", name])}.`;
  const references = new Set<string>();
  for (const { path, expression } of deferredSites) {
    const key = deferredSiteKey(path);
    if (!key.startsWith(prefix)) continue;
    const parsed = parseExpressionEither(expression, {
      filePath: landofilePath,
      bareShellParameters: "preserve",
    });
    if (Result.isFailure(parsed)) continue;
    const members = expressionScopeMembers(parsed.success, "services");
    if (!members.analyzable) {
      return Result.fail(
        new ConfigExpressionError({
          message: "A services.<name> reference must name the service literally.",
          expression,
          path: key,
          filePath: landofilePath,
          remediation: "Write the service name directly, for example services.database.creds.user.",
        }),
      );
    }
    for (const member of members.members) references.add(member);
  }
  return Result.succeed(references);
};

/**
 * Order services so every one resolves after the services whose credentials
 * it reads, keeping declaration order wherever the references allow it.
 *
 * A service that reads its own `services.<name>.creds.*`, or a pair that read
 * each other's, can never be satisfied: credentials exist only after the type
 * resolves, so that is reported as a cycle at the first service involved.
 * References to undeclared services do not participate; those fail at the
 * value site when the scope is evaluated.
 */
export const orderServicesByCredsReferences = (input: {
  readonly landofile: LandofileShape;
  readonly deferredSites: DeferredExpressionSites;
  readonly landofilePath: string;
}): Result.Result<ReadonlyArray<string>, ConfigExpressionError> => {
  const names = Object.keys(input.landofile.services ?? {});
  if (input.deferredSites.length === 0) return Result.succeed(names);
  const declared = new Set(names);
  const pending = new Map<string, Set<string>>();
  for (const name of names) {
    const references = referencedServices(name, input.deferredSites, input.landofilePath);
    if (Result.isFailure(references)) return Result.fail(references.failure);
    pending.set(name, new Set([...references.success].filter((reference) => declared.has(reference))));
  }
  const ordered: string[] = [];
  const resolved = new Set<string>();
  while (ordered.length < names.length) {
    const next = names.find((name) => {
      const references = pending.get(name);
      return !resolved.has(name) && references !== undefined && [...references].every((r) => resolved.has(r));
    });
    if (next === undefined) {
      const stuck = names.find((name) => !resolved.has(name)) ?? names[0] ?? "";
      const blockers = [...(pending.get(stuck) ?? [])].filter((reference) => !resolved.has(reference));
      return Result.fail(
        new ConfigExpressionError({
          message:
            blockers.length === 1 && blockers[0] === stuck
              ? `Service ${stuck} reads its own credentials through services.${stuck}.creds, which exist only after it resolves.`
              : `Services ${[stuck, ...blockers.filter((b) => b !== stuck)].join(" and ")} reference each other's credentials, so neither can resolve first.`,
          expression: `services.${blockers[0] ?? stuck}.creds`,
          path: deferredSiteKey(["services", stuck]),
          filePath: input.landofilePath,
          remediation:
            "Break the cycle: a service's own credentials are not available to its configuration, and two services cannot each derive credentials from the other.",
        }),
      );
    }
    ordered.push(next);
    resolved.add(next);
  }
  return Result.succeed(ordered);
};

const serviceCredsScopeByPlan = new WeakMap<AppPlan, ServiceCredsScope>();

/**
 * Remember the `services` scope a plan was resolved with, so a consumer that
 * re-reads Landofile declarations against an existing plan (tooling) can
 * evaluate `services.<name>.creds.*` the same way the planner did.
 */
export const attachServiceCredsScope = (plan: AppPlan, scope: ServiceCredsScope): AppPlan => {
  serviceCredsScopeByPlan.set(plan, scope);
  return plan;
};

export const serviceCredsScopeForPlan = (plan: AppPlan): ServiceCredsScope | undefined =>
  serviceCredsScopeByPlan.get(plan);

export const materializeLandofileScopesForPlan = Effect.fnUntraced(function* (
  input: MaterializeLandofileScopesInput,
  plan: AppPlan,
) {
  const identityScoped = yield* materializeLandofileScopes(input);
  if (identityScoped.deferredSites.length === 0) return identityScoped.landofile;
  return yield* materializeServiceScopeSites({
    value: identityScoped.landofile,
    landofilePath: input.landofilePath,
    pathPrefix: [],
    deferredSites: identityScoped.deferredSites,
    context: serviceScopeContext({
      ...identityScoped,
      services: serviceCredsScopeForPlan(plan) ?? {},
    }),
  });
});
