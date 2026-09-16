import type { ServiceBuildStepIntent } from "@lando/sdk/services";

import type { PhpDbClientFamily } from "./php-db-client.ts";
import { phpMysqlArmSource } from "./php-mysql-arm.ts";

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
  fingerprint: "B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8",
} as const;

type ClientInstall = { readonly family: PhpDbClientFamily; readonly version: string };

type AptInstall = {
  readonly listName: string;
  readonly sourceLine: string;
  readonly keyUrl: string;
  readonly keyFingerprint: string;
  readonly packageName: string;
};

const aptCommand = (install: AptInstall): string =>
  [
    "set -eux",
    "export DEBIAN_FRONTEND=noninteractive",
    "apt-get update",
    "apt-get install -y --no-install-recommends ca-certificates gnupg",
    `php -r '$url = "${install.keyUrl}"; $target = "/tmp/lando-db-client.key"; if (copy($url, $target) !== true) { exit(1); }'`,
    `gpg --show-keys --with-colons /tmp/lando-db-client.key | grep -F "fpr:::::::::${install.keyFingerprint}:"`,
    `gpg --dearmor < /tmp/lando-db-client.key > /etc/apt/keyrings/${install.listName}.gpg`,
    `printf '%s\\n' "${install.sourceLine}" > /etc/apt/sources.list.d/${install.listName}.list`,
    "apt-get update",
    `apt-get install -y --no-install-recommends ${install.packageName}`,
    `rm -rf /var/lib/apt/lists/* /tmp/lando-db-client.key /etc/apt/sources.list.d/${install.listName}.list /etc/apt/keyrings/${install.listName}.gpg`,
  ].join(" && ");

const mysqlComponent = (version: string): string => {
  switch (version) {
    case "8.0":
      return "mysql-8.0";
    case "8.4":
      return "mysql-8.4-lts";
    case "9.7":
      return "mysql-9.7-lts";
    default:
      throw new RangeError(`Unsupported MySQL client version ${version}`);
  }
};

const mysqlSource = (version: string) => {
  const component = mysqlComponent(version);
  const sourceLine = `deb [signed-by=/etc/apt/keyrings/mysql.gpg] https://repo.mysql.com/apt/debian bookworm ${component}`;
  const { command: armCommand, ...armArtifact } = phpMysqlArmSource(version);
  return {
    kind: "apt" as const,
    package: "mysql-community-client",
    packageVersion: version,
    repository: `https://repo.mysql.com/apt/debian bookworm ${component}`,
    signingKeyFingerprint: MYSQL_KEY.fingerprint,
    architectures: ["amd64", "arm64"] as const,
    artifacts: { arm64: armArtifact },
    verification: {
      kind: "apt-release-signature" as const,
      signingKeyUrl: MYSQL_KEY.url,
      signingKeyFingerprint: MYSQL_KEY.fingerprint,
    },
    command: `arch=$(dpkg --print-architecture) && case "$arch" in amd64) ${aptCommand({
      listName: "mysql",
      sourceLine,
      keyUrl: MYSQL_KEY.url,
      keyFingerprint: MYSQL_KEY.fingerprint,
      packageName: "mysql-community-client",
    })} ;; arm64) ${armCommand} ;; *) echo "Unsupported architecture $arch for Oracle MySQL clients. Supported: amd64, arm64." >&2; exit 1 ;; esac`,
  };
};

const mariadbSource = (version: string) => ({
  kind: "apt" as const,
  package: "mariadb-client",
  packageVersion: version,
  repository: `https://dlm.mariadb.com/repo/mariadb-server/${version}/repo/debian bookworm main`,
  signingKeyFingerprint: MARIADB_KEY.fingerprint,
  command: aptCommand({
    listName: "mariadb",
    sourceLine: `deb [signed-by=/etc/apt/keyrings/mariadb.gpg] https://dlm.mariadb.com/repo/mariadb-server/${version}/repo/debian bookworm main`,
    keyUrl: MARIADB_KEY.url,
    keyFingerprint: MARIADB_KEY.fingerprint,
    packageName: "mariadb-client",
  }),
});

const postgresSource = (version: string) => ({
  kind: "apt" as const,
  package: `postgresql-client-${version}`,
  packageVersion: version,
  repository: "https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main",
  signingKeyFingerprint: PGDG_KEY.fingerprint,
  command: aptCommand({
    listName: "pgdg",
    sourceLine:
      "deb [signed-by=/etc/apt/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main",
    keyUrl: PGDG_KEY.url,
    keyFingerprint: PGDG_KEY.fingerprint,
    packageName: `postgresql-client-${version}`,
  }),
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

export const phpDbClientBuildStepsForSources = (
  installs: ReadonlyArray<ClientInstall>,
): ReadonlyArray<ServiceBuildStepIntent> =>
  installs.map((install) => {
    const source = sourceFor(install);
    return {
      id: `service-lando.php:db-client:${install.family}`,
      phase: "build",
      command: source.command,
      user: "root",
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
            ...("architectures" in source ? { architectures: source.architectures } : {}),
            ...("verification" in source ? { verification: source.verification } : {}),
            ...("artifacts" in source ? { artifacts: source.artifacts } : {}),
          },
        },
      },
    };
  });
