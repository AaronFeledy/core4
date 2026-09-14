import type { Effect } from "effect";

import type { SqlRecoveryUnavailableError } from "@lando/sdk/errors";
import type { AbsolutePath } from "@lando/sdk/schema";

import type { SqlExec, SqlMover } from "./actions.ts";
import type { SqlPublisher } from "./progress.ts";
import type { SqlRecoveryDeps } from "./recovery.ts";
import type { SqlLandofile, SqlPlan } from "./views.ts";

export type DbAction =
  | "import"
  | "export"
  | "snapshot"
  | "snapshots"
  | "prune"
  | "restore"
  | "reset"
  | "seed";

export type DbCommandInput = {
  readonly action: DbAction;
  readonly yes: boolean;
  readonly service?: string;
  readonly file?: string;
  readonly snapshotId?: string;
  readonly label?: string;
  readonly compression?: "gzip" | "zstd" | "none";
  readonly fromApp?: string;
  readonly fromPath?: string;
  readonly hostCwd?: string;
  readonly keepLatest?: number;
  readonly preview?: boolean;
};

export type SqlCommandDeps = SqlMover &
  SqlRecoveryDeps & {
    readonly landofile: SqlLandofile;
    readonly plan: SqlPlan;
    readonly exec: SqlExec;
    readonly canonicalizeSourcePath: (
      path: string,
    ) => Effect.Effect<AbsolutePath, SqlRecoveryUnavailableError>;
    readonly confirm: (message: string) => Effect.Effect<boolean, unknown>;
    readonly publish: SqlPublisher;
  };
