import { realpath } from "node:fs/promises";

import { SqlRecoveryUnavailableError } from "@lando/sdk/errors";
import { Effect } from "effect";

import type { SqliteHelperContext, SqliteHelperDeps } from "./sqlite-helper.ts";
import type { SqlFileTarget } from "./target.ts";

export const resolveSqliteTargetIdentity = Effect.fn("Sql.resolveSqliteTargetIdentity")(function* (
  deps: SqliteHelperDeps,
  helper: SqliteHelperContext,
  target: SqlFileTarget,
) {
  const mount = helper.covering;
  const relativeFile = helper.dbPath.slice(mount.target === "/" ? 1 : mount.target.length + 1);
  if (mount.kind === "bind") {
    const source = yield* Effect.tryPromise({
      try: () => realpath(mount.source),
      catch: (cause) =>
        new SqlRecoveryUnavailableError({
          message: `Cannot resolve the canonical SQLite bind source for ${target.name}.`,
          service: target.name,
          reason: String(cause),
          remediation: "Use a local passthrough bind whose source can be resolved before retrying.",
        }),
    });
    return JSON.stringify([
      "sqlite-target-v1",
      deps.applied.provider,
      target.path,
      "bind",
      source,
      relativeFile,
    ]);
  }
  const identity = helper.volumeIdentity;
  if (identity === undefined)
    return yield* Effect.fail(
      new SqlRecoveryUnavailableError({
        message: `Cannot identify the SQLite volume for ${target.name}.`,
        service: target.name,
        reason: "The volume has no verified canonical owner and generation.",
        remediation: "Resolve volume ownership before retrying.",
      }),
    );
  return JSON.stringify([
    "sqlite-target-v1",
    deps.applied.provider,
    target.path,
    "volume",
    identity.coordinationKey,
    identity.nativeName,
    identity.generation,
    identity.ownerRoot,
    mount.subpath ?? "",
    relativeFile,
  ]);
});

export const requireSameSqliteTarget = (expected: string, actual: string, service: string) =>
  expected === actual
    ? Effect.void
    : Effect.fail(
        new SqlRecoveryUnavailableError({
          message: `SQLite storage changed during the operation on ${service}.`,
          service,
          reason:
            "The canonical bind source or physical volume target no longer matches the captured target.",
          remediation: "Preserve any recovery evidence, resolve the mount change, then retry.",
        }),
      );
