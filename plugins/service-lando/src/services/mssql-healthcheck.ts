export const mssqlHealthcheck = (port: number): readonly string[] => [
  "/bin/sh",
  "-c",
  `export SQLCMDPASSWORD="$MSSQL_SA_PASSWORD"
out=$(LC_ALL=C "$@" 2>&1) && exit 0
case "$out" in
  "Sqlcmd: Error: Microsoft ODBC Driver 18 for SQL Server : Login failed for user 'sa'..") exit 0 ;;
  *) exit 1 ;;
esac`,
  "lando-mssql-health",
  "/opt/mssql-tools18/bin/sqlcmd",
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
  "2",
  "-Q",
  "SET NOCOUNT ON; SELECT 1;",
];
