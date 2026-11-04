import type { Lando3TranslatorPorts } from "./contract.ts";

export interface CatalogEntry {
  readonly configKeys?: Readonly<Record<string, "server" | "dir" | "drop">>;
  readonly configMounts?: Readonly<Record<string, string>>;
  /** The version the Lando 3 plugin used when the Landofile named none. */
  readonly lando3Default?: string;
}

export const CATALOG: Readonly<Record<string, CatalogEntry>> = {
  php: { lando3Default: "7.4" },
  node: { lando3Default: "14" },
  mysql: { configKeys: { database: "server" }, lando3Default: "5.7" },
  mariadb: { configKeys: { database: "server" }, lando3Default: "10.3" },
  postgres: { configKeys: { database: "server" }, lando3Default: "10" },
  mongodb: { configKeys: { database: "server" }, lando3Default: "4.2" },
  redis: { configKeys: { server: "drop" }, lando3Default: "7.4" },
  solr: { configKeys: { dir: "dir" }, lando3Default: "7" },
  elasticsearch: { configKeys: { server: "drop" }, lando3Default: "6" },
  opensearch: {},
  meilisearch: {},
  phpmyadmin: { configMounts: { config: "/etc/phpmyadmin/config.user.inc.php" }, lando3Default: "5.1" },
  varnish: { configKeys: { vcl: "drop" }, lando3Default: "6.0" },
  tomcat: { lando3Default: "8" },
  python: { lando3Default: "3.7" },
  ruby: { lando3Default: "2.7" },
  go: { lando3Default: "1.26" },
  dotnet: { lando3Default: "2.1" },
  mssql: { lando3Default: "2017-latest" },
  rabbitmq: {},
  apache: {
    lando3Default: "2.4",
    configMounts: {
      server: "/usr/local/apache2/conf/httpd.conf",
      vhosts: "/usr/local/apache2/conf/extra/httpd-vhosts.conf",
    },
  },
  nginx: {
    lando3Default: "1.29",
    configMounts: { server: "/etc/nginx/nginx.conf", vhosts: "/etc/nginx/conf.d/default.conf" },
    configKeys: { params: "drop" },
  },
  compose: {},
  lando: {},
  memcached: { lando3Default: "1" },
  mailpit: { lando3Default: "1.31" },
  mailhog: {},
  minio: {},
  localstack: {},
  valkey: {},
  static: {},
};

export const LEGACY_TYPE_ALIASES: Readonly<Record<string, string>> = { mongo: "mongodb" };

/**
 * Portable Lando 3 recipes ship `<recipe>-<type>` builders (`lamp-php`, `drupal-mysql`)
 * that extend the plain catalog type with a bundled plugin version; hosting-platform
 * recipe builders add platform behavior and stay unknown.
 */
const RECIPE_TYPE_PREFIX = /^(?:lamp|lemp|drupal|wordpress|laravel|symfony|backdrop|joomla|mean)-(.+)$/;

const catalogTypeId = (legacyId: string): string => {
  const base = RECIPE_TYPE_PREFIX.exec(legacyId)?.[1] ?? legacyId;
  return (Object.hasOwn(LEGACY_TYPE_ALIASES, base) ? LEGACY_TYPE_ALIASES[base] : undefined) ?? base;
};

export type CatalogResolution =
  | {
      readonly _tag: "resolved";
      readonly id: string;
      readonly version?: string;
      readonly v4Type: string;
      readonly renamedFrom?: string;
      /** The authored exact release, when Lando 4 ships only its release line. */
      readonly narrowedFrom?: string;
      /** Lando 3's default version, used because the Landofile named none. */
      readonly lando3Default?: string;
    }
  | {
      readonly _tag: "unsupported-version";
      readonly id: string;
      readonly version: string;
      readonly supported: readonly string[];
      readonly lando3Default?: string;
    }
  | { readonly _tag: "unknown-type"; readonly id: string };

const VERSION_REQUIRED: ReadonlySet<string> = new Set(["php", "go", "python", "ruby"]);

export const resolveCatalogType = (
  legacyType: string,
  serviceFacts: Lando3TranslatorPorts["serviceFacts"],
): CatalogResolution => {
  const separator = legacyType.indexOf(":");
  const legacyId = separator === -1 ? legacyType : legacyType.slice(0, separator);
  const id = catalogTypeId(legacyId);
  const entry = Object.hasOwn(CATALOG, id) && Object.hasOwn(serviceFacts, id) ? serviceFacts[id] : undefined;
  if (entry === undefined) return { _tag: "unknown-type", id };
  const authored = separator === -1 ? undefined : legacyType.slice(separator + 1);
  const lando3Default =
    authored === undefined && entry.versions.length > 0 ? CATALOG[id]?.lando3Default : undefined;
  const requested = authored ?? lando3Default;
  // An exact Lando 3 release such as 24.7.0 maps to the longest shipped line it belongs to.
  const version =
    requested === undefined || entry.versions.includes(requested)
      ? requested
      : entry.versions
          .filter(
            (line) =>
              requested.startsWith(`${line}.`) && /^\d+(?:\.\d+)*$/.test(requested.slice(line.length + 1)),
          )
          .sort((left, right) => right.length - left.length)[0];
  const defaulted = lando3Default === undefined ? {} : { lando3Default };
  if (version === undefined && (authored !== undefined || VERSION_REQUIRED.has(id))) {
    return {
      _tag: "unsupported-version",
      id,
      version: authored ?? "",
      supported: entry.versions,
      ...defaulted,
    };
  }
  return {
    _tag: "resolved",
    id,
    ...(version === undefined ? {} : { version }),
    v4Type: version === undefined ? id : `${id}:${version}`,
    ...(id === legacyId ? {} : { renamedFrom: legacyId }),
    ...(authored === undefined || authored === version ? {} : { narrowedFrom: authored }),
    ...defaulted,
  };
};
