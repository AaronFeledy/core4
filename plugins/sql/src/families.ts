export type SqlFamily = "mysql" | "mariadb" | "postgres" | "mongodb" | "mssql";

export type SqlCommandCreds = {
  readonly user: string;
  readonly database: string;
};

const SQL_FAMILIES = {
  mysql: "mysql",
  mariadb: "mariadb",
  postgres: "postgres",
  postgresql: "postgres",
  mongodb: "mongodb",
  mongo: "mongodb",
  mssql: "mssql",
} as const;

type SqlFamilyKey = keyof typeof SQL_FAMILIES;

const isSqlFamilyKey = (value: string): value is SqlFamilyKey => Object.hasOwn(SQL_FAMILIES, value);

const assertNever = (value: never): never => {
  throw new Error(`unexpected SQL family: ${String(value)}`);
};

export const familyFromServiceType = (type: string): SqlFamily | undefined => {
  const separator = type.indexOf(":");
  const prefix = separator === -1 ? type : type.slice(0, separator);
  return isSqlFamilyKey(prefix) ? SQL_FAMILIES[prefix] : undefined;
};

export const isSqlServiceType = (type: string): boolean => familyFromServiceType(type) !== undefined;

export const mssqlBackupServicePath = (database: string): string => `/var/opt/mssql/backup/${database}.bak`;

export const mssqlBackupCommand = (database: string): ReadonlyArray<string> => [
  "sqlcmd",
  "-U",
  "sa",
  "-Q",
  `BACKUP DATABASE [${database}] TO DISK = '${mssqlBackupServicePath(database)}' WITH INIT`,
];

export const mssqlRestoreCommand = (database: string): ReadonlyArray<string> => [
  "sqlcmd",
  "-U",
  "sa",
  "-Q",
  `RESTORE DATABASE [${database}] FROM DISK = '${mssqlBackupServicePath(database)}' WITH REPLACE`,
];

type MysqlFamily = "mysql" | "mariadb";

const MYSQL_FAMILY_BINARIES = {
  mysql: { client: "mysql", dump: "mysqldump" },
  mariadb: { client: "mariadb", dump: "mariadb-dump" },
} as const satisfies Record<MysqlFamily, { readonly client: string; readonly dump: string }>;

const mysqlFamilyBinaries = (family: MysqlFamily): (typeof MYSQL_FAMILY_BINARIES)[MysqlFamily] =>
  MYSQL_FAMILY_BINARIES[family];

const mysqlClient = (
  family: MysqlFamily,
  creds: SqlCommandCreds,
  extra: ReadonlyArray<string>,
): ReadonlyArray<string> => [mysqlFamilyBinaries(family).client, "-u", creds.user, ...extra];

const postgresClient = (creds: SqlCommandCreds, extra: ReadonlyArray<string>): ReadonlyArray<string> => [
  "psql",
  "-U",
  creds.user,
  "-d",
  creds.database,
  ...extra,
];

const quoteShell = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

const mongoTool = (program: string, extra: string): ReadonlyArray<string> => [
  "sh",
  "-c",
  `${program} --uri="$MONGO_URI" ${extra}`,
];

export const dumpCommand = (
  family: Exclude<SqlFamily, "mssql">,
  creds: SqlCommandCreds,
): ReadonlyArray<string> => {
  switch (family) {
    case "mysql":
    case "mariadb":
      return [mysqlFamilyBinaries(family).dump, "-u", creds.user, creds.database];
    case "postgres":
      return ["pg_dump", "-U", creds.user, "-d", creds.database];
    case "mongodb":
      return mongoTool("mongodump --archive", `--db=${quoteShell(creds.database)}`);
    default:
      return assertNever(family);
  }
};

export const loadCommand = (family: SqlFamily, creds: SqlCommandCreds): ReadonlyArray<string> => {
  switch (family) {
    case "mysql":
    case "mariadb":
      return mysqlClient(family, creds, [creds.database]);
    case "postgres":
      return postgresClient(creds, []);
    case "mongodb":
      return mongoTool("mongorestore --archive", `--nsInclude=${quoteShell(`${creds.database}.*`)}`);
    case "mssql":
      return mssqlRestoreCommand(creds.database);
    default:
      return assertNever(family);
  }
};

export const countCommand = (family: SqlFamily, creds: SqlCommandCreds): ReadonlyArray<string> => {
  switch (family) {
    case "mysql":
    case "mariadb":
      return mysqlClient(family, creds, [
        "-D",
        creds.database,
        "-N",
        "-e",
        "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE() AND table_type='BASE TABLE'",
      ]);
    case "postgres":
      return postgresClient(creds, [
        "-tAc",
        "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public'",
      ]);
    case "mongodb":
      return mongoTool("mongosh --quiet", `--eval=${quoteShell("db.getCollectionNames().length")}`);
    case "mssql":
      return [
        "sqlcmd",
        "-U",
        "sa",
        "-d",
        creds.database,
        "-Q",
        "SELECT COUNT(*) FROM sys.tables",
        "-h",
        "-1",
      ];
    default:
      return assertNever(family);
  }
};

export const resetCommand = (family: SqlFamily, creds: SqlCommandCreds): ReadonlyArray<string> => {
  switch (family) {
    case "mysql":
    case "mariadb":
      return mysqlClient(family, creds, [
        "-e",
        `DROP DATABASE IF EXISTS \`${creds.database}\`; CREATE DATABASE \`${creds.database}\`;`,
      ]);
    case "postgres":
      return postgresClient(creds, [
        "-c",
        `DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO ${creds.user};`,
      ]);
    case "mongodb":
      return mongoTool("mongosh", `--eval=${quoteShell("db.dropDatabase()")}`);
    case "mssql":
      return [
        "sqlcmd",
        "-U",
        "sa",
        "-Q",
        `ALTER DATABASE [${creds.database}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${creds.database}]; CREATE DATABASE [${creds.database}];`,
      ];
    default:
      return assertNever(family);
  }
};
