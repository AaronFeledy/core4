import type { SqlRecoveryUnavailableError } from "@lando/sdk/errors";
import type { ExecutableCommandStdio } from "@lando/sdk/plugins";
import type { AbsolutePath } from "@lando/sdk/schema";
import type { EnvironmentValueResolver, RuntimeProvider } from "@lando/sdk/services";
import type { PrivateFileAccess } from "@lando/state-store/private-file-access";
import type { Effect } from "effect";
import type { SqlExec, SqlMover } from "./actions.ts";
import type { SqlPublisher } from "./progress.ts";
import type { SqlRecoveryDeps } from "./recovery.ts";
import type { SqliteSnapshotDeps } from "./sqlite-snapshot.ts";
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
  readonly compressionLevel?: number;
  readonly fromApp?: string;
  readonly fromPath?: string;
  readonly fromService?: string;
  readonly hostCwd?: string;
  readonly keepLatest?: number;
  readonly preview?: boolean;
  readonly stdio?: ExecutableCommandStdio;
};

export type SqlCommandDeps = SqlMover &
  Omit<SqlRecoveryDeps, "exec"> & {
    readonly landofile: SqlLandofile;
    readonly plan: SqlPlan;
    readonly exec: (
      service: string,
      command: ReadonlyArray<string>,
      env?: Readonly<Record<string, string>>,
    ) => ReturnType<SqlExec>;
    readonly environmentResolver: EnvironmentValueResolver["Service"];
    readonly providerId: string;
    readonly waitForReady: (service: string) => Effect.Effect<void, unknown>;
    readonly appliedPlans?: RuntimeProvider["Service"]["appliedPlans"];
    readonly inspectSource: RuntimeProvider["Service"]["inspect"];
    readonly canonicalizeSourcePath: (
      path: string,
    ) => Effect.Effect<AbsolutePath, SqlRecoveryUnavailableError>;
    readonly confirm: (message: string) => Effect.Effect<boolean, unknown>;
    readonly publish: SqlPublisher;
    readonly sqlite?: SqliteSnapshotDeps;
    /** Host directory for staging stdin and compressed dumps before import or seed. */
    readonly stagingDir: string;
    readonly privateFileAccess: PrivateFileAccess;
  };
