import type { DatabaseConnection } from "@lando/sdk/schema";
import { containerAddress } from "./container-address.ts";
import { mongoAdminProof } from "./mongodb-admin-proof.ts";
import { mysqlAdminProofSql } from "./mysql-admin-proof.ts";
import { postgresManagedAdminProofSql } from "./postgres-admin-policy.ts";
import type { ClientRequest } from "./types.ts";

const ipv4 =
  containerAddress +
  `
addr=$(container_address)
[ -n "$addr" ]
`;

const postgres =
  ipv4 +
  `
pg() { psql -XAtw -v ON_ERROR_STOP=1 -p "$PORT" "$@"; }
admin=$(pg -h /var/run/postgresql -U lando_admin -d postgres -v name="$DATABASE" <<'SQL'
SELECT ${postgresManagedAdminProofSql}
AND EXISTS (SELECT FROM pg_database WHERE datname = :'name' AND datallowconn);
SQL
)
[ "$admin" = t ]
[ "$(PGPASSWORD="$PASSWORD" pg -h "$addr" -U "$USER_NAME" -d "$DATABASE" -c 'SELECT 1')" = 1 ]
if denied=$(PGPASSWORD="$PASSWORD.lando-negative-control" pg -h "$addr" -U "$USER_NAME" -d "$DATABASE" -c 'SELECT 1' 2>&1); then exit 1; fi
case "$denied" in *'password authentication failed'*) ;; *) exit 1 ;; esac
`;

const mysql =
  ipv4 +
  String.raw`
client=mysql
[ "$FAMILY" != mariadb ] || client=mariadb
localdb() { "$client" --no-defaults --batch --raw --skip-column-names --connect-timeout=2 --protocol=SOCKET "$@"; }
remotedb() { "$client" --no-defaults --batch --raw --skip-column-names --connect-timeout=2 --protocol=TCP -h "$addr" -P "$PORT" "$@"; }
if [ "$FAMILY" = mysql ]; then
  proof=$(MYSQL_PWD="$ADMIN_PASSWORD" localdb -u lando_admin <<'SQL'
${mysqlAdminProofSql}
SQL
)
  [ "$proof" = 1 ]
else
  grants=$(MYSQL_PWD="$ADMIN_PASSWORD" localdb -u lando_admin -e 'SELECT CURRENT_USER(); SHOW GRANTS FOR CURRENT_USER;')
  printf '%s\n' "$grants" | grep -Fxq 'lando_admin@localhost'
  printf '%s\n' "$grants" | grep -Eq '^GRANT ALL PRIVILEGES ON \*\.\* TO .* WITH GRANT OPTION$'
fi
inventory=$(MYSQL_PWD="$ADMIN_PASSWORD" localdb -u lando_admin <<SQL
SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME = '$DATABASE';
SELECT Host FROM mysql.user WHERE User='root' AND Host IN ('localhost','%');
SQL
)
printf '%s\n' "$inventory" | grep -Fxq 1
[ "$(MYSQL_PWD="$PASSWORD" remotedb -u "$USER_NAME" -D "$DATABASE" -e 'SELECT CURRENT_USER()')" = "$USER_NAME@%" ]
grants=$(MYSQL_PWD="$ADMIN_PASSWORD" localdb -u lando_admin -e "SHOW GRANTS FOR '$USER_NAME'@'%'")
escaped=$(printf '%s' "$DATABASE" | sed 's/_/\\_/g')
printf '%s\n' "$grants" | grep -Fq "GRANT ALL PRIVILEGES ON \x60$DATABASE\x60.* TO " ||
  printf '%s\n' "$grants" | grep -Fq "GRANT ALL PRIVILEGES ON \x60$escaped\x60.* TO "
if [ -n "$ROOT_PASSWORD" ]; then
  if printf '%s\n' "$inventory" | grep -Fxq localhost; then
    [ "$(MYSQL_PWD="$ROOT_PASSWORD" localdb -u root -e 'SELECT CURRENT_USER()')" = root@localhost ]
  fi
  if printf '%s\n' "$inventory" | grep -Fxq '%'; then
    [ "$(MYSQL_PWD="$ROOT_PASSWORD" remotedb -u root -e 'SELECT CURRENT_USER()')" = root@% ]
  fi
fi
`.replaceAll("\\x60", "\\`");

const mongodb = `
export HOME
HOME=$(mktemp -d)
trap 'rm -rf "$HOME"' EXIT
mongosh --nodb --norc --quiet --eval '
const admin = connect(process.env.ADMIN_URI);
${mongoAdminProof}
if (!adminVerified) quit(1);
const status = connect(process.env.APP_URI).runCommand({connectionStatus:1});
if (status.ok !== 1 || !status.authInfo.authenticatedUsers.some(u => u.user === process.env.USER_NAME && u.db === "admin")) quit(1);
' >/dev/null
`;

const mssql = `
sqlcmd() { /opt/mssql-tools18/bin/sqlcmd -S "127.0.0.1,$PORT" -U "$1" -d "$2" -C -b -r1 -l 2 -t 3 -x -h -1 -W -Q "$3"; }
admin=$(SQLCMDPASSWORD="$ADMIN_PASSWORD" sqlcmd lando_admin master "SET NOCOUNT ON; SELECT CASE WHEN ORIGINAL_LOGIN() = N'lando_admin' AND IS_SRVROLEMEMBER(N'sysadmin') = 1 AND EXISTS (SELECT 1 FROM sys.databases WHERE name = N'$DATABASE' AND state = 0) THEN 1 ELSE 0 END;")
[ "$admin" = 1 ]
[ "$(SQLCMDPASSWORD="$PASSWORD" sqlcmd sa "$DATABASE" 'SET NOCOUNT ON; SELECT 1;')" = 1 ]
`;

const batches = { postgres, mysql, mariadb: mysql, mongodb, mssql };

export const matchedBatch = (input: {
  readonly family: DatabaseConnection["family"];
  readonly port: number;
  readonly user: string;
  readonly database: string;
  readonly password: string;
  readonly rootPassword: string | undefined;
  readonly adminPassword: string;
}): ClientRequest | undefined => {
  const { user, database, family, port, password, rootPassword, adminPassword } = input;
  if (!/^[a-zA-Z0-9_]+$/u.test(user) || !/^[a-zA-Z0-9_]+$/u.test(database)) return undefined;
  const mongoUri = (user: string, password: string) =>
    `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/admin?directConnection=true&serverSelectionTimeoutMS=2000&connectTimeoutMS=2000`;
  return {
    argv: ["sh", "-ec", `${batches[family]}\nprintf 'lando-matched\\n'`],
    env: {
      PORT: String(port),
      FAMILY: family,
      USER_NAME: user,
      DATABASE: database,
      ...(family === "mongodb"
        ? { ADMIN_URI: mongoUri("lando_admin", adminPassword), APP_URI: mongoUri(user, password) }
        : {
            PASSWORD: family === "mssql" ? (rootPassword ?? password) : password,
            ROOT_PASSWORD: rootPassword ?? "",
            ADMIN_PASSWORD: adminPassword,
          }),
      PGCONNECT_TIMEOUT: "2",
    },
  };
};
