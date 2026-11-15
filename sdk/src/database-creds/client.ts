import { concatenateEnvironmentValues, encodeEnvironmentComponent } from "../expressions/index.ts";
import type { DatabaseClientCreds, DatabaseLocalCheck, Environment } from "../schema/index.ts";
import { DATABASE_FAMILY_LOCAL_CLIENT_ARGS, type DatabaseFamily } from "./families.ts";

export type { DatabaseClientCreds, DatabaseLocalCheck } from "../schema/index.ts";

/** How long one local connection check may take before it is unverified, not rejected. */
export const DATABASE_LOCAL_CHECK_TIMEOUT_MS = 8_000;

const DATABASE_CONNECT_TIMEOUT_SECONDS = 3;

const MONGO_DEFAULT_SUFFIX = "?authSource=admin";
const MONGO_CHECK_SUFFIX =
  "?authSource=admin&directConnection=true&serverSelectionTimeoutMS=3000&connectTimeoutMS=3000&socketTimeoutMS=3000";

const mongoConnectionUri = (creds: DatabaseClientCreds, suffix: string): Environment["MONGO_URI"] =>
  concatenateEnvironmentValues([
    "mongodb://",
    encodeEnvironmentComponent(creds.user),
    ":",
    encodeEnvironmentComponent(creds.password),
    `@127.0.0.1:${creds.port}/`,
    encodeEnvironmentComponent(creds.database),
    suffix,
  ]);

/**
 * The environment one generated Lando client of a family receives. Mongo's URI already carries
 * the password so the shell task never needs it in argv; the SQL Server aliases all agree.
 */
export const databaseClientEnvironment = (
  family: DatabaseFamily,
  creds: DatabaseClientCreds,
): Environment => {
  switch (family) {
    case "mysql":
    case "mariadb":
      return { MYSQL_PWD: creds.password };
    case "postgres":
      return { PGPASSWORD: creds.password };
    case "mongodb":
      return { MONGO_URI: mongoConnectionUri(creds, MONGO_DEFAULT_SUFFIX) };
    case "mssql": {
      const password = creds.rootPassword ?? creds.password;
      return { SQLCMDPASSWORD: password, SA_PASSWORD: password, MSSQL_SA_PASSWORD: password };
    }
    default:
      return family satisfies never;
  }
};

const mysqlClient = (family: "mysql" | "mariadb", creds: DatabaseClientCreds): ReadonlyArray<string> => [
  family,
  "-h",
  "127.0.0.1",
  "-P",
  String(creds.port),
  "-u",
  creds.user,
  ...DATABASE_FAMILY_LOCAL_CLIENT_ARGS[family],
  `--connect-timeout=${DATABASE_CONNECT_TIMEOUT_SECONDS}`,
  "-D",
  creds.database,
  "-N",
  "-B",
  "-e",
  "SELECT 1",
];

/**
 * PostgreSQL images trust loopback connections, so a query over 127.0.0.1 is accepted with any
 * password. The check connects to the container's own network address instead, where the image
 * applies the password rule other containers meet, and falls back to loopback only when the
 * image cannot report an address. Values reach psql as positional parameters, never as shell text.
 */
const postgresClient = (creds: DatabaseClientCreds): ReadonlyArray<string> => [
  "sh",
  "-c",
  'host=$(hostname -i 2>/dev/null | cut -d " " -f 1); exec psql -h "${host:-127.0.0.1}" -p "$1" -U "$2" -d "$3" -w -X -tAc "SELECT 1"',
  "lando-db-check",
  String(creds.port),
  creds.user,
  creds.database,
];

/**
 * MongoDB refuses to authenticate a database handle that was never written, so a missing
 * configured database is only observable through the authenticated command, not its name.
 * A disposable HOME keeps the shell from creating state on the data volume.
 */
const mongoClient = (): ReadonlyArray<string> => [
  "bash",
  "-ec",
  [
    "umask 077",
    "probe_home=$(mktemp -d /tmp/lando-db-check.XXXXXXXX)",
    "trap 'rm -rf -- \"$probe_home\"' EXIT",
    'HOME="$probe_home" mongosh --norc --quiet --eval "db=connect(process.env.MONGO_URI); db.runCommand({ ping: 1 })"',
  ].join("\n"),
];

const mssqlClient = (creds: DatabaseClientCreds): ReadonlyArray<string> => [
  "/opt/mssql-tools18/bin/sqlcmd",
  "-S",
  `127.0.0.1,${creds.port}`,
  "-U",
  creds.user,
  "-C",
  "-b",
  "-r1",
  "-d",
  creds.database,
  "-l",
  String(DATABASE_CONNECT_TIMEOUT_SECONDS),
  "-t",
  "5",
  "-Q",
  "SELECT 1",
];

/** Build the one local connection check for a family and login, over explicit TCP loopback. */
export const databaseLocalCheck = (
  family: DatabaseFamily,
  creds: DatabaseClientCreds,
): DatabaseLocalCheck => {
  switch (family) {
    case "mysql":
    case "mariadb":
      return {
        argv: mysqlClient(family, creds),
        environment: databaseClientEnvironment(family, creds),
        timeoutMs: DATABASE_LOCAL_CHECK_TIMEOUT_MS,
      };
    case "postgres":
      return {
        argv: postgresClient(creds),
        environment: {
          ...databaseClientEnvironment(family, creds),
          PGCONNECT_TIMEOUT: String(DATABASE_CONNECT_TIMEOUT_SECONDS),
        },
        timeoutMs: DATABASE_LOCAL_CHECK_TIMEOUT_MS,
      };
    case "mongodb":
      return {
        argv: mongoClient(),
        environment: { MONGO_URI: mongoConnectionUri(creds, MONGO_CHECK_SUFFIX) },
        timeoutMs: DATABASE_LOCAL_CHECK_TIMEOUT_MS,
      };
    case "mssql":
      return {
        argv: mssqlClient(creds),
        environment: databaseClientEnvironment(family, creds),
        timeoutMs: DATABASE_LOCAL_CHECK_TIMEOUT_MS,
      };
    default:
      return family satisfies never;
  }
};
