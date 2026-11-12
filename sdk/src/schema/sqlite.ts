import { Schema } from "effect";

// ==== SQLite file target ======================================================
// App-mount-relative path authored as `services.<name>.sqlite.path`. Absolute
// paths, Windows drive prefixes, backslashes, and `..` are
// rejected. DatabaseFamily stays server-only; this schema is the file-backed
// counterpart stamped onto ServiceConfig and ServicePlan.

/**
 * App-mount-relative SQLite file path. Absolute paths, Windows drive prefixes,
 * backslashes, and `..` are rejected.
 */
export const sqliteAppRelativePathIssue = (value: string): string | undefined => {
  if (value.length === 0) return "sqlite.path must be a non-empty path relative to the app mount.";
  if (value.includes("\0")) return "sqlite.path cannot contain NUL.";
  if (value.includes("\\")) return "sqlite.path must use POSIX separators, not backslashes.";
  if (value.startsWith("/")) {
    return "sqlite.path must be relative to the app mount; absolute paths are rejected.";
  }
  if (/^[A-Za-z]:/u.test(canonicalSqlitePath(value))) {
    return "sqlite.path cannot have a Windows drive prefix.";
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "..")) {
    return "sqlite.path cannot contain a .. segment.";
  }
  if (value.endsWith("/")) return "sqlite.path must name a file, not end with a slash.";
  if (canonicalSqlitePath(value).length === 0) {
    return "sqlite.path must name a file inside the app mount, not the app mount itself.";
  }
  return undefined;
};

/** Canonical POSIX spelling for a validated app-relative SQLite file path. */
export const canonicalSqlitePath = (value: string): string =>
  value
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/");

export const isSqliteAppRelativePath = (value: string): boolean =>
  sqliteAppRelativePathIssue(value) === undefined;

const SqliteAppRelativePath = Schema.String.check(
  Schema.makeFilter((value) => sqliteAppRelativePathIssue(value)),
);

/**
 * File-backed SQLite database authored on an app service as `services.<name>.sqlite`.
 */
export const SqliteTargetConfig = Schema.Struct({
  path: SqliteAppRelativePath.annotate({
    description:
      "Path to the SQLite database file, relative to this service's app mount. Absolute paths and .. segments are rejected.",
  }),
}).annotate({
  identifier: "SqliteTargetConfig",
  title: "SQLite Target",
  description:
    "File-backed SQLite database on an app service. Lando runs db:import, db:export, db:snapshot, db:restore, and db:reset against this file.",
});
export type SqliteTargetConfig = typeof SqliteTargetConfig.Type;
