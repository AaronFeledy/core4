import { Effect } from "effect";

import type {
  AppFeatureContext,
  AppFeatureDefinition,
  AppFeatureServiceView,
  ServiceBuildStepIntent,
} from "@lando/sdk/services";

const PHP_FEATURE_ID = "service-lando.php";

export const PHP_DB_CLIENT_FEATURE_ID = "service-lando.php.db-client" as const;
export const PHP_DB_CLIENT_FAMILIES = ["mariadb", "mongodb", "mysql", "postgres"] as const;
export type PhpDbClientFamily = (typeof PHP_DB_CLIENT_FAMILIES)[number];

export const PHP_DB_CLIENT_VERSIONS = {
  mysql: ["8.0", "8.4"],
  mariadb: ["10.6", "10.11", "11.4"],
  postgres: ["14", "15", "16", "17"],
  mongodb: ["6", "7", "8"],
} as const;

export const PHP_DB_CLIENT_DEFAULTS = {
  mysql: "8.0",
  mariadb: "11.4",
  postgres: "16",
  mongodb: "7",
} as const;

export const PHP_MONGOSH_RELEASE = {
  version: "2.10.0",
  package: "mongodb-mongosh",
  artifacts: {
    amd64: {
      url: "https://github.com/mongodb-js/mongosh/releases/download/v2.10.0/mongodb-mongosh-shared-openssl3_2.10.0_amd64.deb",
      sha256: "6e8f9077126cc628c860d972b00c2df6b5ccb8cc1e0a78fcf87c620981002f98",
    },
    arm64: {
      url: "https://github.com/mongodb-js/mongosh/releases/download/v2.10.0/mongodb-mongosh-shared-openssl3_2.10.0_arm64.deb",
      sha256: "b98b13633e05f80401387c412a72a6c334ec547814c233e16dccd761cc724cf2",
    },
  },
} as const;

const MYSQL_KEY = {
  url: "https://repo.mysql.com/RPM-GPG-KEY-mysql-2025",
  fingerprint: "BCA43417C3B485DD128EC6D4B7B3B788A8D3785C",
} as const;
const MARIADB_KEY = {
  url: "https://supplychain.mariadb.com/mariadb-keyring-2019.gpg",
  fingerprint: "177F4010FE56CA3336300305F1656F24C74CD1D8",
} as const;
const PGDG_KEY = {
  url: "https://www.postgresql.org/media/keys/ACCC4CF8.asc",
  fingerprint: "7FCC7D46ACCC4CF8",
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
  throw new Error(`Unsupported database client ${JSON.stringify(value)}. ${PHP_DB_CLIENT_REMEDIATION}`);
};

const compareVersions = (left: string, right: string): number =>
  left.localeCompare(right, undefined, { numeric: true });

const familyFromServiceType = (serviceType: string): ClientInstall | undefined => {
  const separator = serviceType.indexOf(":");
  const family = separator <= 0 ? serviceType : serviceType.slice(0, separator);
  if (!isFamily(family)) return undefined;
  const requested = separator <= 0 ? PHP_DB_CLIENT_DEFAULTS[family] : serviceType.slice(separator + 1);
  return versionsFor(family).includes(requested) ? { family, version: requested } : undefined;
};

export const detectPhpDbClients = (
  views: ReadonlyArray<AppFeatureServiceView>,
): ReadonlyArray<ClientInstall> => {
  const highest = new Map<PhpDbClientFamily, string>();
  for (const view of views) {
    const detected = familyFromServiceType(view.serviceType);
    if (detected === undefined) continue;
    const current = highest.get(detected.family);
    if (current === undefined || compareVersions(detected.version, current) > 0) {
      highest.set(detected.family, detected.version);
    }
  }
  return PHP_DB_CLIENT_FAMILIES.flatMap((family) => {
    const version = highest.get(family);
    return version === undefined ? [] : [{ family, version }];
  });
};

const aptCommand = (listName: string, sourceLine: string, keyUrl: string, packageName: string): string =>
  [
    "set -eux",
    "export DEBIAN_FRONTEND=noninteractive",
    "apt-get update",
    "apt-get install -y --no-install-recommends ca-certificates gnupg",
    `php -r '$url = "${keyUrl}"; $target = "/tmp/lando-db-client.key"; if (copy($url, $target) !== true) { exit(1); }'`,
    `gpg --dearmor < /tmp/lando-db-client.key > /etc/apt/keyrings/${listName}.gpg`,
    `printf '%s\\n' "${sourceLine}" > /etc/apt/sources.list.d/${listName}.list`,
    "apt-get update",
    `apt-get install -y --no-install-recommends ${packageName}`,
    `rm -rf /var/lib/apt/lists/* /tmp/lando-db-client.key /etc/apt/sources.list.d/${listName}.list /etc/apt/keyrings/${listName}.gpg`,
  ].join(" && ");

const mysqlSource = (version: string) => {
  const component = version === "8.4" ? "mysql-8.4-lts" : "mysql-8.0";
  return {
    kind: "apt" as const,
    package: "mysql-community-client",
    packageVersion: version,
    repository: `http://repo.mysql.com/apt/debian bookworm ${component}`,
    signingKeyFingerprint: MYSQL_KEY.fingerprint,
    command: aptCommand(
      "mysql",
      `deb [signed-by=/etc/apt/keyrings/mysql.gpg] http://repo.mysql.com/apt/debian bookworm ${component}`,
      MYSQL_KEY.url,
      "mysql-community-client",
    ),
  };
};

const mariadbSource = (version: string) => ({
  kind: "apt" as const,
  package: "mariadb-client",
  packageVersion: version,
  repository: `https://dlm.mariadb.com/repo/mariadb-server/${version}/repo/debian bookworm main`,
  signingKeyFingerprint: MARIADB_KEY.fingerprint,
  command: aptCommand(
    "mariadb",
    `deb [signed-by=/etc/apt/keyrings/mariadb.gpg] https://dlm.mariadb.com/repo/mariadb-server/${version}/repo/debian bookworm main`,
    MARIADB_KEY.url,
    "mariadb-client",
  ),
});

const postgresSource = (version: string) => ({
  kind: "apt" as const,
  package: `postgresql-client-${version}`,
  packageVersion: version,
  repository: "https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main",
  signingKeyFingerprint: PGDG_KEY.fingerprint,
  command: aptCommand(
    "pgdg",
    "deb [signed-by=/etc/apt/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main",
    PGDG_KEY.url,
    `postgresql-client-${version}`,
  ),
});

const mongodbCommand = (): string => {
  const amd64 = PHP_MONGOSH_RELEASE.artifacts.amd64;
  const arm64 = PHP_MONGOSH_RELEASE.artifacts.arm64;
  return [
    "set -eux",
    "arch=$(dpkg --print-architecture)",
    `if [ "$arch" = amd64 ]; then url="${amd64.url}"; sha="${amd64.sha256}"; elif [ "$arch" = arm64 ]; then url="${arm64.url}"; sha="${arm64.sha256}"; else echo "Unsupported architecture $arch for mongodb client. Supported: amd64, arm64."; exit 1; fi`,
    'LANDO_MONGOSH_URL="$url" LANDO_MONGOSH_SHA="$sha" php -r \'$url = getenv("LANDO_MONGOSH_URL"); $sha = getenv("LANDO_MONGOSH_SHA"); $target = "/tmp/mongosh.deb"; if ($url === false || $sha === false || copy($url, $target) !== true) { exit(1); } $actual = hash_file("sha256", $target); if ($actual === false || !hash_equals($sha, $actual)) { fwrite(STDERR, "mongosh checksum mismatch\\n"); exit(1); }\'',
    "dpkg -i /tmp/mongosh.deb",
    "rm -f /tmp/mongosh.deb",
  ].join(" && ");
};

const mongodbSource = {
  kind: "archive" as const,
  package: PHP_MONGOSH_RELEASE.package,
  packageVersion: PHP_MONGOSH_RELEASE.version,
  artifacts: PHP_MONGOSH_RELEASE.artifacts,
  command: mongodbCommand(),
};

const sourceFor = (install: ClientInstall) => {
  switch (install.family) {
    case "mysql":
      return mysqlSource(install.version);
    case "mariadb":
      return mariadbSource(install.version);
    case "postgres":
      return postgresSource(install.version);
    case "mongodb":
      return mongodbSource;
    default: {
      const exhaustive: never = install.family;
      return exhaustive;
    }
  }
};

export const phpDbClientBuildSteps = (
  installs: ReadonlyArray<ClientInstall>,
): ReadonlyArray<ServiceBuildStepIntent> =>
  installs.map((install) => {
    const source = sourceFor(install);
    return {
      id: `service-lando.php:db-client:${install.family}`,
      phase: "build",
      command: source.command,
      dependsOn: ["service-lando.php:prerequisites"],
      buildKeyInputs: {
        dbClient: {
          family: install.family,
          version: install.version,
          source: {
            kind: source.kind,
            package: source.package,
            packageVersion: source.packageVersion,
            ...("repository" in source ? { repository: source.repository } : {}),
            ...("signingKeyFingerprint" in source
              ? { signingKeyFingerprint: source.signingKeyFingerprint }
              : {}),
            ...("artifacts" in source ? { artifacts: source.artifacts } : {}),
          },
        },
      },
    };
  });

const installsFor = (selection: PhpDbClientSelection, views: ReadonlyArray<AppFeatureServiceView>) => {
  if (selection.mode === "disabled") return [];
  if (selection.mode === "explicit") return [{ family: selection.family, version: selection.version }];
  return detectPhpDbClients(views);
};

const applyPhpDbClient = (ctx: AppFeatureContext): void => {
  ctx.forEachSelected((mutator) => {
    if (!mutator.service.featureIds.includes(PHP_FEATURE_ID)) return;
    if (mutator.service.normalizedConfig.image !== undefined) return;
    const selection = resolvePhpDbClient(mutator.service.normalizedConfig.db_client);
    for (const step of phpDbClientBuildSteps(installsFor(selection, ctx.selected))) {
      mutator.addBuildStep(step);
    }
  });
};

export const phpDbClientFeature: AppFeatureDefinition = {
  id: PHP_DB_CLIENT_FEATURE_ID,
  priority: 100,
  activatedBy: { services: { hasFeature: PHP_FEATURE_ID } },
  selectors: {
    hasFeature: [PHP_FEATURE_ID],
    types: ["mariadb", "mongodb", "mysql", "postgres"],
  },
  apply: (ctx) => Effect.sync(() => applyPhpDbClient(ctx)),
};
