const SQLCMD = "/opt/mssql-tools18/bin/sqlcmd";

const identifier = (value: string): string => `[${value.replaceAll("]", "]]")}]`;
const literal = (value: string): string => `N'${value.replaceAll("'", "''")}'`;

export const mssqlAdminCommand = (port: number, query: string): readonly string[] => [
  SQLCMD,
  "-S",
  `localhost,${port}`,
  "-U",
  "sa",
  "-C",
  "-b",
  "-r1",
  "-d",
  "master",
  "-l",
  "2",
  "-t",
  "5",
  "-Q",
  query,
];

export const mssqlHealthcheck = (database: string, port: number): readonly string[] => [
  "/bin/bash",
  "-c",
  'export SQLCMDPASSWORD="$SA_PASSWORD"; exec "$@"',
  "lando-mssql-health",
  ...mssqlAdminCommand(
    port,
    `IF NOT EXISTS (SELECT 1 FROM sys.databases WHERE name = ${literal(database)} AND state_desc = 'ONLINE' AND HAS_DBACCESS(name) = 1) THROW 50000, 'Database is not accessible', 1;`,
  ),
];

/** PID 1 owns both children, forwards shutdown, and reaps the server on initialization failure. */
export const mssqlStartupCommand = (database: string, port: number): readonly string[] => [
  "/bin/bash",
  "-c",
  `
set -u
query=$1
shift
server=0
worker=0
cleanup() {
  trap '' TERM INT
  if [ "$worker" -ne 0 ]; then kill -TERM "$worker" 2>/dev/null || :; wait "$worker" 2>/dev/null || :; fi
  if [ "$server" -ne 0 ]; then kill -TERM "$server" 2>/dev/null || :; wait "$server" 2>/dev/null || :; fi
}
trap 'cleanup; exit 143' TERM
trap 'cleanup; exit 130' INT
export SQLCMDPASSWORD="$SA_PASSWORD"
/opt/mssql/bin/sqlservr &
server=$!
ready=0
for ((attempt=0; attempt<60; attempt++)); do
  if ! kill -0 "$server" 2>/dev/null; then wait "$server"; status=$?; cleanup; [ "$status" -ne 0 ] || status=1; exit "$status"; fi
  "$@" -Q 'SELECT 1' &
  worker=$!
  if wait "$worker"; then ready=1; worker=0; break; fi
  worker=0
  sleep 1 &
  worker=$!
  wait "$worker"
  worker=0
done
if [ "$ready" -ne 1 ]; then cleanup; exit 1; fi
"$@" -Q "$query" &
worker=$!
wait "$worker"
status=$?
worker=0
if [ "$status" -ne 0 ]; then cleanup; exit "$status"; fi
wait "$server"
status=$?
server=0
exit "$status"
`,
  "lando-mssql-startup",
  `IF DB_ID(${literal(database)}) IS NULL BEGIN EXEC(${literal(`CREATE DATABASE ${identifier(database)}`)}); PRINT ${literal(JSON.stringify({ event: "lando.database.created", database }))}; END;`,
  ...mssqlAdminCommand(port, "").slice(0, -2),
];
