import { Effect, Schema, absurd } from "effect";

import { AppFeatureSelectorMatchedNothingError, type PhpMyAdminHostsCredsError } from "@lando/sdk/errors";
import { PortNumber, type ServiceConfig, ServiceName } from "@lando/sdk/schema";
import { PhpMyAdminServiceConfig } from "@lando/sdk/schema/services/phpmyadmin";
import type {
  AppFeatureContext,
  AppFeatureDefinition,
  AppFeatureServiceMutators,
  AppFeatureServiceView,
  ServiceFeatureContext,
  ServiceFeatureDefinition,
  ServiceType,
} from "@lando/sdk/services";

import {
  loopbackTcpHealthcheck,
  rootIdentity,
  serviceFeatureApply,
  serviceTypeResolve,
} from "./_feature-helpers.ts";
import {
  type AuthoredHostsWire,
  type PmaCreds,
  authoredPmaCreds,
  resolveAuthoredHosts,
} from "./_phpmyadmin-hosts.ts";
import { assertListenerConfig, plannedPort } from "./_port-helpers.ts";
import { applyAuthoredProcessFields } from "./_process-helpers.ts";

const DEFAULT_PORT = Schema.decodeUnknownSync(PortNumber)(80);
const PHPMYADMIN_LISTENER = { port: DEFAULT_PORT, variable: "APACHE_PORT", daemon: "phpMyAdmin" } as const;
const DB_TYPES = ["mysql", "mysql:8.0", "mysql:8.4", "mysql:9.7", "mariadb"] as const;
const VERSIONS = ["5", "latest"] as const;
const ARTIFACTS = {
  "5": "phpmyadmin:5",
  latest: "phpmyadmin:latest",
} as const;

export const PHPMYADMIN_FEATURE_ID = "service-lando.phpmyadmin";
export const PHPMYADMIN_WIRE_FEATURE_ID = "service-lando.phpmyadmin.wire";

const applyPhpMyAdminFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  assertListenerConfig(service, PHPMYADMIN_LISTENER);
  const port = plannedPort(service, PHPMYADMIN_LISTENER);

  ctx.setArtifact({ kind: "ref", ref: service.image ?? ARTIFACTS.latest });
  ctx.addEnv("APACHE_PORT", String(port));
  ctx.addEndpoint({
    _tag: "internal",
    port: Schema.decodeUnknownSync(PortNumber)(port),
    protocol: "http",
    name: ctx.serviceName,
  });
  ctx.setHealthcheck(loopbackTcpHealthcheck(port, 20));

  applyAuthoredProcessFields(ctx);
};

export const phpmyadminServiceFeature: ServiceFeatureDefinition = {
  id: PHPMYADMIN_FEATURE_ID,
  schema: Schema.Unknown,
  priority: 600,
  apply: serviceFeatureApply(
    PHPMYADMIN_FEATURE_ID,
    "phpmyadmin service feature failed to apply",
    applyPhpMyAdminFeature,
  ),
};

const makePhpMyAdminServiceType = (id: string, image: string): ServiceType => ({
  id,
  name: "phpmyadmin",
  base: "lando",
  versions: VERSIONS,
  artifacts: ARTIFACTS,
  identity: rootIdentity(),
  schema: PhpMyAdminServiceConfig,
  resolve: (input) => {
    return serviceTypeResolve(id, "phpmyadmin service type failed to resolve", () => {
      assertListenerConfig(input.service, PHPMYADMIN_LISTENER);
      return {
        base: "lando",
        normalizedConfig: {
          ...input.service,
          type: "phpmyadmin",
          image: input.service.image ?? image,
          certs: input.service.certs ?? true,
        },
        features: [{ id: PHPMYADMIN_FEATURE_ID }],
      };
    });
  },
});

export const phpmyadmin5ServiceType = makePhpMyAdminServiceType("phpmyadmin:5", ARTIFACTS["5"]);
export const phpmyadminLatestServiceType = makePhpMyAdminServiceType("phpmyadmin:latest", ARTIFACTS.latest);
export const phpmyadminServiceType = makePhpMyAdminServiceType("phpmyadmin", ARTIFACTS.latest);

const isDbType = (serviceType: string): boolean => DB_TYPES.some((candidate) => candidate === serviceType);

const authoredHosts = (config: ServiceConfig): ReadonlyArray<string> | undefined => {
  const hosts = config.hosts;
  if (hosts === undefined) return undefined;
  return typeof hosts === "string" ? [hosts] : hosts;
};

const discoveredSiblings = (
  selected: ReadonlyArray<AppFeatureServiceView>,
): ReadonlyArray<AppFeatureServiceView> =>
  selected
    .filter((view) => isDbType(view.serviceType))
    .sort((left, right) => left.serviceName.localeCompare(right.serviceName));

const siblingHasHealthProbe = (sibling: AppFeatureServiceView): boolean => {
  const healthcheck = sibling.normalizedConfig.healthcheck;
  return healthcheck !== undefined && healthcheck !== false;
};

const addSiblingDependencies = (
  mutator: AppFeatureServiceMutators,
  siblings: ReadonlyArray<AppFeatureServiceView>,
): void => {
  for (const sibling of siblings) {
    mutator.addDependency({
      service: ServiceName.make(sibling.serviceName),
      condition: siblingHasHealthProbe(sibling) ? "service_healthy" : "service_started",
      required: true,
    });
  }
};

const applyPmaEnv = (
  mutator: AppFeatureServiceMutators,
  target: { readonly hosts: ReadonlyArray<string>; readonly ports: readonly number[] },
  creds: PmaCreds,
): void => {
  mutator.addEnv("PMA_HOSTS", target.hosts.join(","));
  mutator.addEnv("PMA_PORTS", target.ports.join(","));
  mutator.addEnv("PMA_USER", creds.user);
  mutator.addEnv("PMA_PASSWORD", creds.password);
};

type AuthoredHostsOk = Extract<AuthoredHostsWire, { readonly _tag: "ok" }>;

const applyPhpMyAdminWire = (ctx: AppFeatureContext): Effect.Effect<void, PhpMyAdminHostsCredsError> => {
  const siblings = discoveredSiblings(ctx.selected);
  const authored = new Map<string, AuthoredHostsOk>();
  for (const view of ctx.selected) {
    if (view.serviceType !== "phpmyadmin") continue;
    const hosts = authoredHosts(view.normalizedConfig) ?? siblings.map((sibling) => sibling.serviceName);
    const resolved = resolveAuthoredHosts({
      hosts,
      siblings,
      pmaCreds: authoredPmaCreds(view.normalizedConfig),
      feature: ctx.featureId,
    });
    switch (resolved._tag) {
      case "fail":
        return Effect.fail(resolved.error);
      case "ok":
        authored.set(view.serviceName, resolved);
        break;
      default:
        return absurd<never>(resolved);
    }
  }

  ctx.forEachSelected((mutator) => {
    if (mutator.service.serviceType !== "phpmyadmin") return;
    const override = authored.get(mutator.service.serviceName);
    if (override !== undefined) {
      applyPmaEnv(mutator, override, override.creds);
      addSiblingDependencies(mutator, override.matched);
      return;
    }
  });
  return Effect.void;
};

export const phpMyAdminWireFeature: AppFeatureDefinition = {
  id: PHPMYADMIN_WIRE_FEATURE_ID,
  priority: 100,
  activatedBy: { services: { type: "phpmyadmin" } },
  selectors: { types: ["phpmyadmin", ...DB_TYPES] },
  apply: Effect.fn("PhpMyAdminWireFeature.apply")(function* (ctx) {
    const needsDiscovery = ctx.selected.some(
      (view) => view.serviceType === "phpmyadmin" && authoredHosts(view.normalizedConfig) === undefined,
    );
    if (needsDiscovery && discoveredSiblings(ctx.selected).length === 0) {
      return yield* Effect.fail(
        new AppFeatureSelectorMatchedNothingError({
          message: `App feature ${ctx.featureId} found no mysql/mariadb siblings and no hosts: override`,
          feature: ctx.featureId,
          remediation: "Add a mysql or mariadb service, or author hosts: on the phpmyadmin service.",
        }),
      );
    }
    yield* applyPhpMyAdminWire(ctx);
  }),
};
