export const mssqlBackupServicePath = (database: string): string =>
  `/var/opt/mssql/backup/${encodeURIComponent(database)}.bak`;

const identifier = (value: string): string => `[${value.replaceAll("]", "]]")}]`;
const literal = (value: string): string => `N'${value.replaceAll("'", "''")}'`;

export const mssqlClient = (port: number, extra: ReadonlyArray<string>): ReadonlyArray<string> => [
  "/opt/mssql-tools18/bin/sqlcmd",
  "-S",
  `localhost,${port}`,
  "-U",
  "sa",
  "-C",
  "-b",
  "-r1",
  ...extra,
];

export const mssqlPrepareBackupCommand = (database: string): ReadonlyArray<string> => [
  "sh",
  "-c",
  'mkdir -p "$1" && rm -f -- "$2"',
  "lando-mssql-backup",
  "/var/opt/mssql/backup",
  mssqlBackupServicePath(database),
];

export const mssqlBackupCommand = (database: string, port: number): ReadonlyArray<string> =>
  mssqlClient(port, [
    "-d",
    "master",
    "-Q",
    `BACKUP DATABASE ${identifier(database)} TO DISK = ${literal(mssqlBackupServicePath(database))} WITH INIT`,
  ]);

export const mssqlRestoreCommand = (database: string, port: number): ReadonlyArray<string> =>
  mssqlClient(port, [
    "-d",
    "master",
    "-Q",
    `RESTORE DATABASE ${identifier(database)} FROM DISK = ${literal(mssqlBackupServicePath(database))} WITH REPLACE`,
  ]);

export const mssqlResetCommand = (database: string, port: number): ReadonlyArray<string> =>
  mssqlClient(port, [
    "-d",
    "master",
    "-Q",
    `ALTER DATABASE ${identifier(database)} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${identifier(database)}; CREATE DATABASE ${identifier(database)};`,
  ]);
