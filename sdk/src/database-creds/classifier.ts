import type { DatabaseClientCheckResult, DatabaseClientCheckState } from "../schema/index.ts";
import type { DatabaseFamily } from "./families.ts";

export type { DatabaseClientCheckResult, DatabaseClientCheckState } from "../schema/index.ts";

interface FamilyPatterns {
  readonly rejected: ReadonlyArray<RegExp>;
  readonly databaseMissing: ReadonlyArray<RegExp>;
}

/**
 * Patterns are matched against output captured from the official images in
 * `sdk/test/database-creds/fixtures`. A missing client, an unreachable server, a TLS
 * failure, or an unrecognized message stays unverified so start never reports a
 * credential problem it cannot prove.
 */
const MYSQL_PROTOCOL_PATTERNS: FamilyPatterns = {
  rejected: [/ERROR 1045\b/u, /Access denied for user [^\n]*\(using password: YES\)/u],
  databaseMissing: [
    /ERROR 1044\b/u,
    /ERROR 1049\b/u,
    /Access denied for user [^\n]* to database /u,
    /Unknown database /u,
  ],
};

const FAMILY_PATTERNS = {
  mysql: MYSQL_PROTOCOL_PATTERNS,
  mariadb: MYSQL_PROTOCOL_PATTERNS,
  postgres: {
    rejected: [/password authentication failed/iu],
    databaseMissing: [/database "[^"\n]*" does not exist/iu],
  },
  mongodb: {
    rejected: [/(?:MongoServerError|MongoError): Authentication failed/iu],
    databaseMissing: [],
  },
  mssql: {
    rejected: [/Login failed for user/iu],
    databaseMissing: [
      /Cannot open database /iu,
      /Failed to open the explicitly specified database/iu,
      /database "[^"\n]*" does not exist/iu,
    ],
  },
} as const satisfies Record<DatabaseFamily, FamilyPatterns>;

const matches = (patterns: ReadonlyArray<RegExp>, stderr: string): boolean =>
  patterns.some((pattern) => pattern.test(stderr));

/**
 * Classify one check result. `accepted` requires the client itself to exit zero, because
 * stderr warnings are ordinary; every non-zero result must name the condition to count.
 */
export const classifyDatabaseClientResult = (
  family: DatabaseFamily,
  result: DatabaseClientCheckResult,
): DatabaseClientCheckState => {
  if (result.exitCode === 0) return "accepted";
  const patterns = FAMILY_PATTERNS[family];
  if (matches(patterns.databaseMissing, result.stderr)) return "database-missing";
  if (matches(patterns.rejected, result.stderr)) return "rejected";
  return "unverified";
};
