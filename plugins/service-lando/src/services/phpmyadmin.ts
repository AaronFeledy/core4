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

import { loopbackTcpHealthcheck, rootIdentity, serviceFeatureApply } from "./_feature-helpers.ts";
import {
  type AuthoredHostsWire,
  type PmaCreds,
  authoredPmaCreds,
  credentialsFor,
  portsForHosts,
  resolveAuthoredHosts,
} from "./_phpmyadmin-hosts.ts";
import { listenPort } from "./_port-helpers.ts";
import { applyAuthoredProcessFields } from "./_process-helpers.ts";

const DEFAULT_PORT = Schema.decodeUnknownSync(PortNumber)(80);
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
  const port = listenPort(service, ctx.serviceName, {
    port: DEFAULT_PORT,
    variable: "APACHE_PORT",
    daemon: "phpMyAdmin",
  });

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
    return Effect.succeed({
      base: "lando",
      normalizedConfig: {
        ...input.service,
        type: "phpmyadmin",
        image: input.service.image ?? image,
        certs: input.service.certs ?? true,
      },
      features: [{ id: PHPMYADMIN_FEATURE_ID }],
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
  return healthcheck !== undefined && healthcheck.kind !== "none";
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
  target: { readonly hosts: ReadonlyArray<string>; readonly siblings: ReadonlyArray<AppFeatureServiceView> },
  creds: PmaCreds,
): void => {
  mutator.addEnv("PMA_HOSTS", target.hosts.join(","));
  mutator.addEnv("PMA_PORTS", portsForHosts(target.hosts, target.siblings).join(","));
  mutator.addEnv("PMA_USER", creds.user);
  mutator.addEnv("PMA_PASSWORD", creds.password);
};

type AuthoredHostsOk = Extract<AuthoredHostsWire, { readonly _tag: "ok" }>;

const applyPhpMyAdminWire = (ctx: AppFeatureContext): Effect.Effect<void, PhpMyAdminHostsCredsError> => {
  const siblings = discoveredSiblings(ctx.selected);
  const authored = new Map<string, AuthoredHostsOk>();
  for (const view of ctx.selected) {
    if (view.serviceType !== "phpmyadmin") continue;
    const hosts = authoredHosts(view.normalizedConfig);
    if (hosts === undefined) continue;
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
      applyPmaEnv(mutator, { hosts: override.hosts, siblings: override.matched }, override.creds);
      addSiblingDependencies(mutator, override.matched);
      return;
    }
    applyPmaEnv(
      mutator,
      { hosts: siblings.map((sibling) => sibling.serviceName), siblings },
      credentialsFor(siblings),
    );
    addSiblingDependencies(mutator, siblings);
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
