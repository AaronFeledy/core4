export interface CatalogEntry {
  readonly versions: ReadonlyArray<string>;
  readonly containerPort?: number;
  /** Legacy config key to authoring slot; drop means no matching slot exists. */
  readonly configKeys?: Readonly<Record<string, "server" | "dir" | "drop">>;
  readonly configDestination?: string;
  /** Legacy config key mounted read-only at this container path, one mount per key. */
  readonly configMounts?: Readonly<Record<string, string>>;
  /** The Lando 4 service type mounts the app at `/app` unless opted out. */
  readonly appMountByDefault?: true;
}

export const CATALOG: Readonly<Record<string, CatalogEntry>> = {
  php: {
    versions: ["8.1", "8.2", "8.3", "8.4", "8.5", "8.6"],
    appMountByDefault: true,
  },
  node: { versions: ["lts", "22"], containerPort: 3000, appMountByDefault: true },
  mysql: {
    versions: ["8.0", "8.4", "9.7"],
    containerPort: 3306,
    configKeys: { database: "server" },
    configDestination: "/etc/mysql/conf.d/99-lando.cnf",
  },
  mariadb: {
    versions: ["11.4"],
    containerPort: 3306,
    configKeys: { database: "server" },
    configDestination: "/etc/mysql/conf.d/99-lando.cnf",
  },
  postgres: {
    versions: ["16"],
    containerPort: 5432,
    configKeys: { database: "server" },
    configDestination: "/etc/lando/postgresql.conf",
  },
  mongodb: {
    versions: ["7"],
    containerPort: 27017,
    configKeys: { database: "server" },
    configDestination: "/etc/lando/mongod.conf",
  },
  redis: { versions: ["7"], containerPort: 6379, configKeys: { server: "server" } },
  solr: {
    versions: ["9"],
    containerPort: 8983,
    configKeys: { dir: "dir" },
    configDestination: "/var/solr/data/<core>/conf",
  },
  elasticsearch: { versions: ["8"], containerPort: 9200, configKeys: { server: "server" } },
  opensearch: { versions: ["2"], containerPort: 9200 },
  meilisearch: { versions: ["1"], containerPort: 7700 },
  phpmyadmin: {
    versions: ["5", "latest"],
    containerPort: 80,
    configMounts: { config: "/etc/phpmyadmin/config.user.inc.php" },
  },
  varnish: { versions: ["6", "7"], containerPort: 8080, configKeys: { vcl: "drop" } },
  tomcat: { versions: ["9", "10", "11"], containerPort: 8080, appMountByDefault: true },
  python: { versions: ["3.12"], appMountByDefault: true },
  ruby: { versions: ["3.3"], appMountByDefault: true },
  go: { versions: ["1.22", "1.23"], appMountByDefault: true },
  dotnet: { versions: ["8.0", "9.0"], appMountByDefault: true },
  mssql: { versions: ["2019", "2022"], containerPort: 1433 },
  rabbitmq: { versions: ["3", "4"], containerPort: 5672 },
  apache: {
    versions: [],
    containerPort: 80,
    configMounts: {
      server: "/usr/local/apache2/conf/httpd.conf",
      vhosts: "/usr/local/apache2/conf/extra/httpd-vhosts.conf",
    },
    appMountByDefault: true,
  },
  nginx: {
    versions: [],
    appMountByDefault: true,
    containerPort: 80,
    configMounts: {
      server: "/etc/nginx/nginx.conf",
      vhosts: "/etc/nginx/conf.d/default.conf",
    },
    configKeys: { params: "drop" },
  },
  compose: { versions: [], appMountByDefault: true },
  lando: { versions: [], appMountByDefault: true },
  memcached: { versions: [], containerPort: 11211 },
  mailpit: { versions: [], containerPort: 1025 },
  mailhog: { versions: [], containerPort: 1025 },
  minio: { versions: [] },
  localstack: { versions: [] },
  valkey: { versions: [] },
  static: { versions: [], appMountByDefault: true },
};

export const LEGACY_TYPE_ALIASES: Readonly<Record<string, string>> = { mongo: "mongodb" };

export type CatalogResolution =
  | {
      readonly _tag: "resolved";
      readonly id: string;
      readonly version?: string;
      readonly v4Type: string;
      readonly renamedFrom?: string;
    }
  | {
      readonly _tag: "unsupported-version";
      readonly id: string;
      readonly version: string;
      readonly supported: ReadonlyArray<string>;
    }
  | { readonly _tag: "unknown-type"; readonly id: string };

const VERSION_REQUIRED: ReadonlySet<string> = new Set(["php", "go", "python", "ruby"]);

export const resolveCatalogType = (legacyType: string): CatalogResolution => {
  const separator = legacyType.indexOf(":");
  const legacyId = separator === -1 ? legacyType : legacyType.slice(0, separator);
  const id =
    (Object.hasOwn(LEGACY_TYPE_ALIASES, legacyId) ? LEGACY_TYPE_ALIASES[legacyId] : undefined) ?? legacyId;
  const entry = Object.hasOwn(CATALOG, id) ? CATALOG[id] : undefined;
  if (entry === undefined) return { _tag: "unknown-type", id };
  const version = separator === -1 ? undefined : legacyType.slice(separator + 1);
  if (version === undefined ? VERSION_REQUIRED.has(id) : !entry.versions.includes(version)) {
    return { _tag: "unsupported-version", id, version: version ?? "", supported: entry.versions };
  }
  return {
    _tag: "resolved",
    id,
    ...(version === undefined ? {} : { version }),
    v4Type: version === undefined ? id : `${id}:${version}`,
    ...(id === legacyId ? {} : { renamedFrom: legacyId }),
  };
};
