// MySQL can expand global ALL PRIVILEGES in SHOW GRANTS. Prove the grantable privileges
// required for account and database changes, including the separate dynamic SYSTEM_USER grant.
const privileges = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "CREATE",
  "DROP",
  "REFERENCES",
  "INDEX",
  "ALTER",
  "CREATE TEMPORARY TABLES",
  "LOCK TABLES",
  "EXECUTE",
  "CREATE VIEW",
  "SHOW VIEW",
  "CREATE ROUTINE",
  "ALTER ROUTINE",
  "EVENT",
  "TRIGGER",
  "CREATE USER",
  "SYSTEM_USER",
] as const;

export const mysqlAdminProofSql = `SELECT CURRENT_USER() = 'lando_admin@localhost'
  AND (SELECT COUNT(*) FROM information_schema.USER_PRIVILEGES
    WHERE GRANTEE = CONCAT(QUOTE('lando_admin'), '@', QUOTE('localhost')) AND IS_GRANTABLE = 'YES'
      AND PRIVILEGE_TYPE IN (${privileges.map((name) => `'${name}'`).join(", ")})) = ${privileges.length}
  AND EXISTS (SELECT 1 FROM information_schema.USER_ATTRIBUTES
    WHERE USER = 'lando_admin' AND HOST = 'localhost'
      AND JSON_UNQUOTE(JSON_EXTRACT(ATTRIBUTE, '$.comment')) = 'lando:db-admin:v1');`;
