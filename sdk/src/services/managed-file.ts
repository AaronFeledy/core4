import { Context, type Effect, type Scope } from "effect";

import type { ManagedFileError } from "../errors/index.ts";
import type {
  ManagedFile,
  ManagedFileInfo,
  ManagedFilePlan,
  ManagedFileResult,
  PortablePath,
} from "../schema/index.ts";

/** Selects ledger-recorded managed files for `remove`, by owner, id, path, or base. */
export interface ManagedFileSelector {
  readonly owner?: string;
  readonly id?: string;
  readonly path?: PortablePath;
  readonly base?: string;
}

/** Options for `apply`. `force` overrides a detected conflict (back up then update). */
export interface ManagedFileApplyOptions {
  readonly force?: boolean;
}

/**
 * The single chokepoint for Lando-owned writes into the user's working tree.
 * Renders content, encodes structured formats, applies ownership
 * markers, records a `StateStore` ledger, detects drift/adoption, and refuses
 * to silently clobber a user edit. Available at bootstrap level `minimal`,
 * host/test-overridable, but not a plugin contribution surface.
 */
export class ManagedFileService extends Context.Tag("@lando/core/ManagedFileService")<
  ManagedFileService,
  {
    readonly plan: (files: ReadonlyArray<ManagedFile>) => Effect.Effect<ManagedFilePlan, ManagedFileError>;
    readonly apply: (
      files: ReadonlyArray<ManagedFile>,
      opts?: ManagedFileApplyOptions,
    ) => Effect.Effect<ManagedFileResult, ManagedFileError, Scope.Scope>;
    readonly remove: (selector: ManagedFileSelector) => Effect.Effect<ManagedFileResult, ManagedFileError>;
    readonly status: Effect.Effect<ReadonlyArray<ManagedFileInfo>, ManagedFileError>;
    readonly adopt: (path: PortablePath) => Effect.Effect<void, ManagedFileError>;
    readonly release: (path: PortablePath) => Effect.Effect<void, ManagedFileError>;
  }
>() {}
