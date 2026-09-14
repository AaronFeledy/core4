import type { DataTransferSpec, SnapshotFilter, SnapshotMetadata } from "@lando/sdk/schema";
import type { SqlCommandDeps } from "../../src/run.ts";

export type ExtraSqlService = { readonly name: string; readonly type: string };
export type SqlTestOptions = {
  readonly password: string;
  readonly rootPassword?: string;
  readonly type?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly countStdout?: string;
  readonly countFails?: boolean;
  readonly countFailuresBeforeSuccess?: number;
  readonly execFails?: boolean;
  readonly restoreFails?: boolean;
  readonly startFails?: boolean;
  readonly initiallyRunning?: boolean;
  readonly runtimeExists?: boolean;
  readonly omitImageIdentity?: boolean;
  readonly observedVersion?: string;
  readonly containerId?: string;
  readonly extraServices?: ReadonlyArray<ExtraSqlService>;
  readonly storage?: ReadonlyArray<{ readonly store: string; readonly target?: string }>;
  readonly seedStatus?: "fresh" | "in-progress" | "seeded" | "failed";
  readonly snapshotVersion?: string;
  readonly snapshotVolumeInstance?: string;
};
export type RecordedExec = {
  readonly command: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
};
export type RecordedSnapshot = {
  readonly store: string;
  readonly format?: string;
  readonly label?: string;
  readonly metadata?: SnapshotMetadata;
};
export type SqlLifecycleStep = "lock" | "snapshot" | "stop" | "restore" | "start" | "resume" | "suspend";
export type SqlTestHarness = {
  readonly root: string;
  readonly deps: SqlCommandDeps;
  readonly transfers: () => ReadonlyArray<DataTransferSpec>;
  readonly snapshots: () => ReadonlyArray<RecordedSnapshot>;
  readonly execs: () => ReadonlyArray<RecordedExec>;
  readonly published: () => ReadonlyArray<string>;
  readonly lifecycle: () => ReadonlyArray<SqlLifecycleStep>;
  readonly snapshotFilters: () => ReadonlyArray<SnapshotFilter>;
  readonly countAttempts: () => number;
  readonly dispose: () => void;
};

export const fixtureDataDestination = (type: string) => {
  const family = type.split(":")[0];
  switch (family) {
    case "postgres":
      return "/var/lib/postgresql/data";
    case "mongodb":
      return "/data/db";
    case "mssql":
      return "/var/opt/mssql";
    default:
      return "/var/lib/mysql";
  }
};
