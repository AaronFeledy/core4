import { Effect } from "effect";

import type { AppFeatureContext, AppFeatureDefinition, AppFeatureServiceView } from "@lando/sdk/services";

import { ServiceConfigIssue } from "./_feature-helpers.ts";
import { phpDbClientBuildStepsForSources } from "./php-db-client-sources.ts";

export { PHP_MONGOSH_RELEASE } from "./php-db-client-sources.ts";

import { readPhpRuntimePolicy } from "./php-runtime-policy.ts";

const PHP_FEATURE_ID = "service-lando.php";

export const PHP_DB_CLIENT_FEATURE_ID = "service-lando.php.db-client" as const;
export const PHP_DB_CLIENT_FAMILIES = ["mariadb", "mongodb", "mysql", "postgres"] as const;
export type PhpDbClientFamily = (typeof PHP_DB_CLIENT_FAMILIES)[number];

export const PHP_DB_CLIENT_VERSIONS = {
  mysql: ["8.0", "8.4", "9.7"],
  mariadb: ["10.6", "10.11", "11.4"],
  postgres: ["14", "15", "16", "17", "18"],
  mongodb: ["6", "7", "8"],
} as const;

export const PHP_DB_CLIENT_DEFAULTS = {
  mysql: "8.0",
  mariadb: "11.4",
  postgres: "16",
  mongodb: "7",
} as const;

export type PhpDbClientSelection =
  | { readonly mode: "auto" }
  | { readonly mode: "disabled" }
  | { readonly mode: "explicit"; readonly family: PhpDbClientFamily; readonly version: string };

type ClientInstall = { readonly family: PhpDbClientFamily; readonly version: string };

const isFamily = (value: string): value is PhpDbClientFamily =>
  (PHP_DB_CLIENT_FAMILIES as ReadonlyArray<string>).includes(value);

const versionsFor = (family: PhpDbClientFamily): ReadonlyArray<string> => PHP_DB_CLIENT_VERSIONS[family];

export const PHP_DB_CLIENT_REMEDIATION = `Set db_client: auto, db_client: false, or a supported explicit client such as db_client: "mariadb:11.4". Supported values: db_client: auto, db_client: false, ${PHP_DB_CLIENT_FAMILIES.flatMap(
  (family) => versionsFor(family).map((version) => `db_client: "${family}:${version}"`),
).join(", ")}.`;

export const resolvePhpDbClient = (value: unknown): PhpDbClientSelection => {
  if (value === undefined || value === "auto") return { mode: "auto" };
  if (value === false) return { mode: "disabled" };
  if (typeof value === "string" && value.length > 0) {
    const separator = value.indexOf(":");
    const family = separator <= 0 ? "" : value.slice(0, separator);
    const version = separator <= 0 ? "" : value.slice(separator + 1);
    if (isFamily(family) && versionsFor(family).includes(version)) {
      return { mode: "explicit", family, version };
    }
  }
  throw new ServiceConfigIssue(
    ["db_client"],
    `Unsupported database client ${JSON.stringify(value)}.`,
    PHP_DB_CLIENT_REMEDIATION,
  );
};

const compareVersions = (left: string, right: string): number =>
  left.localeCompare(right, undefined, { numeric: true });

type ClientDetection =
  | { readonly kind: "known"; readonly install: ClientInstall }
  | { readonly kind: "unknown-mysql"; readonly serviceName: string };

const familyFromService = (view: AppFeatureServiceView): ClientDetection | undefined => {
  const serviceType = view.serviceType;
  const separator = serviceType.indexOf(":");
  const family = separator <= 0 ? serviceType : serviceType.slice(0, separator);
  if (!isFamily(family)) return undefined;
  if (family === "mysql" && separator <= 0 && view.normalizedConfig.image !== undefined) {
    return { kind: "unknown-mysql", serviceName: view.serviceName };
  }
  const requested = separator <= 0 ? PHP_DB_CLIENT_DEFAULTS[family] : serviceType.slice(separator + 1);
  return versionsFor(family).includes(requested)
    ? { kind: "known", install: { family, version: requested } }
    : undefined;
};

export const detectPhpDbClients = (
  views: ReadonlyArray<AppFeatureServiceView>,
): ReadonlyArray<ClientInstall> => {
  const highest = new Map<PhpDbClientFamily, string>();
  for (const view of views) {
    const detection = familyFromService(view);
    if (detection?.kind === "unknown-mysql") {
      throw new ServiceConfigIssue(
        ["db_client"],
        `Service ${detection.serviceName} has unknown MySQL client compatibility.`,
        "Set an explicit db_client supported by that custom image, or set db_client: false.",
      );
    }
    const detected = detection?.install;
    if (detected === undefined) continue;
    const current = highest.get(detected.family);
    if (detected.family === "mysql" && current !== undefined && current !== detected.version) {
      throw new ServiceConfigIssue(
        ["db_client"],
        `Cannot select db_client: auto for mixed MySQL series ${current} and ${detected.version}.`,
        "Set an explicit db_client or set db_client: false.",
      );
    }
    if (current === undefined || compareVersions(detected.version, current) > 0) {
      highest.set(detected.family, detected.version);
    }
  }
  return PHP_DB_CLIENT_FAMILIES.flatMap((family) => {
    const version = highest.get(family);
    return version === undefined ? [] : [{ family, version }];
  });
};

export const phpDbClientBuildSteps = (installs: ReadonlyArray<ClientInstall>) =>
  phpDbClientBuildStepsForSources(installs);

const installsFor = (selection: PhpDbClientSelection, detected: ReadonlyArray<ClientInstall>) => {
  switch (selection.mode) {
    case "disabled":
      return [];
    case "explicit":
      return [{ family: selection.family, version: selection.version }];
    case "auto":
      return detected;
    default:
      return selection satisfies never;
  }
};

const applyPhpDbClient = Effect.fn("PhpDbClient.apply")(function* (ctx: AppFeatureContext) {
  const selections = new Map<string, PhpDbClientSelection>();
  for (const service of ctx.selected) {
    if (!service.featureIds.includes(PHP_FEATURE_ID)) continue;
    const policy = yield* readPhpRuntimePolicy(service, ctx.featureId);
    if (policy.artifactSource === "stock")
      selections.set(service.serviceName, resolvePhpDbClient(service.normalizedConfig.db_client));
  }
  const detected = [...selections.values()].some((selection) => selection.mode === "auto")
    ? detectPhpDbClients(ctx.selected)
    : [];
  ctx.forEachSelected((mutator) => {
    const selection = selections.get(mutator.service.serviceName);
    if (selection === undefined) return;
    for (const step of phpDbClientBuildSteps(installsFor(selection, detected))) {
      mutator.addBuildStep(step);
    }
  });
});

export const phpDbClientFeature: AppFeatureDefinition = {
  id: PHP_DB_CLIENT_FEATURE_ID,
  priority: 100,
  activatedBy: { services: { hasFeature: PHP_FEATURE_ID } },
  selectors: {
    hasFeature: [PHP_FEATURE_ID],
    types: ["mariadb", "mongodb", "mysql", "mysql:8.0", "mysql:8.4", "mysql:9.7", "postgres"],
  },
  apply: applyPhpDbClient,
};
