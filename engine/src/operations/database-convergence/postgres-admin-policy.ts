const unsafeHostTrust = `EXISTS (
  SELECT FROM pg_hba_file_rules
  WHERE error IS NOT NULL OR (type LIKE 'host%' AND auth_method = 'trust' AND NOT (
    (address = '127.0.0.1' AND netmask = '255.255.255.255') IS TRUE OR
    (address = '::1' AND netmask = 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff') IS TRUE
  ))
)`;

export const postgresManagedAdminProofSql = `EXISTS (
  SELECT FROM pg_authid WHERE rolname = 'lando_admin' AND rolname = current_user
    AND rolcanlogin AND rolsuper AND rolpassword IS NULL
    AND shobj_description(oid, 'pg_authid') = 'lando:db-admin:v1'
) AND NOT ${unsafeHostTrust}`;

export const postgresAdminAdoptionBlockedSql = `EXISTS (
  SELECT FROM pg_roles WHERE rolname = 'lando_admin'
) OR ${unsafeHostTrust}`;
