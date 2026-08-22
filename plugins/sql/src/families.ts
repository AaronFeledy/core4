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

const typePrefix = (type: string): string => {
  const separator = type.indexOf(":");
  return separator === -1 ? type : type.slice(0, separator);
};

export const familyFromServiceType = (type: string): SqlFamily | undefined => {
  const prefix = typePrefix(type);
  return isSqlFamilyKey(prefix) ? SQL_FAMILIES[prefix] : undefined;
};

export const isSqlServiceType = (type: string): boolean => familyFromServiceType(type) !== undefined;

export const mssqlBackupServicePath = (database: string): string => `/var/opt/mssql/backup/${database}.bak`;

export const mssqlBackupCommand = (database: string): ReadonlyArray<string> => [
  "sqlcmd",
  "-U",
  "sa",
  "-Q",
  `BACKUP DATABASE [${database}] TO DISK = '${mssqlBackupServicePath(database)}'`,
];

export const mssqlRestoreCommand = (database: string): ReadonlyArray<string> => [
  "sqlcmd",
  "-U",
  "sa",
  "-Q",
  `RESTORE DATABASE [${database}] FROM DISK = '${mssqlBackupServicePath(database)}'`,
];

const mysqlClient = (creds: SqlCommandCreds, extra: ReadonlyArray<string>): ReadonlyArray<string> => [
  "mysql",
  "-u",
  creds.user,
  ...extra,
];

const postgresClient = (creds: SqlCommandCreds, extra: ReadonlyArray<string>): ReadonlyArray<string> => [
  "psql",
  "-U",
  creds.user,
  "-d",
  creds.database,
  ...extra,
];

export const dumpCommand = (
  family: Exclude<SqlFamily, "mssql">,
  creds: SqlCommandCreds,
): ReadonlyArray<string> => {
  switch (family) {
    case "mysql":
    case "mariadb":
      return ["mysqldump", "-u", creds.user, creds.database];
    case "postgres":
      return ["pg_dump", "-U", creds.user, "-d", creds.database];
    case "mongodb":
      return ["mongodump", "--archive"];
    default:
      return assertNever(family);
  }
};

export const loadCommand = (family: SqlFamily, creds: SqlCommandCreds): ReadonlyArray<string> => {
  switch (family) {
    case "mysql":
    case "mariadb":
      return mysqlClient(creds, [creds.database]);
    case "postgres":
      return postgresClient(creds, []);
    case "mongodb":
      return ["mongorestore", "--archive"];
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
      return mysqlClient(creds, [
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
      return ["mongosh", "--quiet", "--eval", "db.getCollectionNames().length"];
    case "mssql":
      return ["sqlcmd", "-U", "sa", "-Q", "SELECT COUNT(*) FROM sys.tables", "-h", "-1"];
    default:
      return assertNever(family);
  }
};

export const resetCommand = (family: SqlFamily, creds: SqlCommandCreds): ReadonlyArray<string> => {
  switch (family) {
    case "mysql":
    case "mariadb":
      return mysqlClient(creds, [
        "-e",
        `DROP DATABASE IF EXISTS \`${creds.database}\`; CREATE DATABASE \`${creds.database}\`;`,
      ]);
    case "postgres":
      return postgresClient(creds, [
        "-c",
        `DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO ${creds.user};`,
      ]);
    case "mongodb":
      return ["mongosh", "--eval", "db.dropDatabase()"];
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
