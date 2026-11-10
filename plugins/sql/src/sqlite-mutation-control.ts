export const sqliteResetSql = (script: string): string => `
PRAGMA foreign_keys=OFF;
.output ${JSON.stringify(script)}
SELECT 'DROP VIEW IF EXISTS main.' || '"' || replace(name, '"', '""') || '";' FROM main.sqlite_schema WHERE type='view' AND name NOT GLOB 'sqlite_*';
SELECT 'DROP TABLE IF EXISTS main.' || '"' || replace(name, '"', '""') || '";' FROM pragma_table_list() WHERE schema='main' AND type IN ('table','virtual') AND name NOT GLOB 'sqlite_*' ORDER BY type DESC;
.output stdout
BEGIN EXCLUSIVE;
.read ${JSON.stringify(script)}
PRAGMA main.user_version=0;
CREATE TEMP TABLE lando_reset_check (remaining INTEGER CHECK (remaining=0));
INSERT INTO temp.lando_reset_check SELECT count(*) FROM main.sqlite_schema WHERE name NOT GLOB 'sqlite_*';
COMMIT;
`;

export const sqliteMutationPrelude = (backup: string | undefined, version: string, ready: string) => `
.bail on
.timeout 5000
PRAGMA main.locking_mode=EXCLUSIVE;
BEGIN EXCLUSIVE;
COMMIT;
CREATE TEMP TABLE lando_journal_check (mode TEXT CHECK (mode IN ('delete','truncate','persist','wal')));
INSERT INTO temp.lando_journal_check SELECT journal_mode FROM pragma_journal_mode();
.output ${JSON.stringify(version)}
SELECT sqlite_version();
.output stdout
${backup === undefined ? "" : `.backup main ${JSON.stringify(backup)}`}
.output ${JSON.stringify(ready)}
SELECT 'ready';
.output stdout
`;
