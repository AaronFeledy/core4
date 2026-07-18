// Constrained context plugins receive instead of internal core objects. Exposes
// `managedFiles`, a `ManagedFileService` view pre-namespaced to the plugin id.
// Plugin writes always record `owner: <plugin-id>`; a plugin cannot see, remove,
// or adopt files owned by another plugin or by core. `stateStore` is likewise
// pre-rooted to `<userDataRoot>/plugins/<plugin-id>/` by the host; plugin code
// cannot select another durable-state root.

import { posix as pathPosix } from "node:path";

import { Effect } from "effect";
import type { Context, Scope } from "effect";

import { EventError, ManagedFileError } from "@lando/sdk/errors";
import type { RenderEvent } from "@lando/sdk/events";
import type {
  AbsolutePath,
  ManagedFile,
  ManagedFileInfo,
  ManagedFilePlan,
  ManagedFileResult,
  PortablePath,
} from "@lando/sdk/schema";
import type {
  ManagedFileApplyOptions,
  ManagedFileSelector,
  ManagedFileService,
  StateStoreShape,
} from "@lando/sdk/services";

import { type PluginStateStore, makePluginStateStore } from "./context-state.ts";

export type { PluginStateBucketSpec } from "./context-state.ts";

type ManagedFileServiceImpl = Context.Tag.Service<typeof ManagedFileService>;

/** A `ManagedFile` a plugin declares; the `owner` and base are supplied by the surface. */
export type PluginManagedFile = Omit<ManagedFile, "owner" | "base"> & {
  readonly owner?: never;
  readonly base?: never;
};

/** A `remove` selector a plugin declares; `owner` and base are supplied by the surface. */
export type PluginManagedFileSelector = Omit<ManagedFileSelector, "owner" | "base"> & {
  readonly owner?: never;
  readonly base?: never;
};

/** The owner-scoped `ManagedFileService` view a plugin operates through. */
export interface PluginManagedFiles {
  readonly pluginId: string;
  readonly plan: (
    files: ReadonlyArray<PluginManagedFile>,
  ) => Effect.Effect<ManagedFilePlan, ManagedFileError>;
  readonly apply: (
    files: ReadonlyArray<PluginManagedFile>,
    opts?: ManagedFileApplyOptions,
  ) => Effect.Effect<ManagedFileResult, ManagedFileError, Scope.Scope>;
  readonly remove: (
    selector?: PluginManagedFileSelector,
  ) => Effect.Effect<ManagedFileResult, ManagedFileError>;
  readonly status: Effect.Effect<ReadonlyArray<ManagedFileInfo>, ManagedFileError>;
  readonly adopt: (path: PortablePath) => Effect.Effect<void, ManagedFileError>;
  readonly release: (path: PortablePath) => Effect.Effect<void, ManagedFileError>;
}

type PluginManagedFileOperation = "plan" | "apply" | "remove" | "adopt" | "release";

const ownerOf = (value: { readonly owner?: unknown }): unknown => value.owner;
const normalizeManagedPath = (path: PortablePath): string => pathPosix.normalize(path);

/**
 * Build a `ManagedFileService` view that forces `owner: ownerId` on every write
 * and refuses to touch another owner's files. A foreign `owner` passed by a
 * non-typed (JS) caller is rejected rather than silently coerced, and any
 * path-keyed operation (`apply`/`plan`/`remove({ path })`/`adopt`/`release`)
 * fails when the ledger already records that path under a different owner.
 */
export const makePluginManagedFiles = (
  ownerId: string,
  service: ManagedFileServiceImpl,
): PluginManagedFiles => {
  const ownershipError = (
    operation: PluginManagedFileOperation,
    path: PortablePath | undefined,
    remediation: string,
  ): ManagedFileError => new ManagedFileError({ reason: "conflict", operation, path, remediation });

  const rejectDeclaredForeignOwner = (
    files: ReadonlyArray<PluginManagedFile>,
    operation: PluginManagedFileOperation,
  ): Effect.Effect<void, ManagedFileError> => {
    for (const file of files) {
      const declared = ownerOf(file);
      if (declared !== undefined && declared !== ownerId) {
        return Effect.fail(
          ownershipError(
            operation,
            file.path,
            `Plugin "${ownerId}" cannot manage files on behalf of owner "${String(declared)}".`,
          ),
        );
      }
      if ("base" in file && file.base !== undefined) {
        return Effect.fail(
          ownershipError(
            operation,
            file.path,
            `Plugin "${ownerId}" cannot declare a managed-file base; plugin files are rooted by the host app.`,
          ),
        );
      }
    }
    return Effect.void;
  };

  const assertNoForeignPath = (
    paths: ReadonlyArray<PortablePath>,
    operation: PluginManagedFileOperation,
  ): Effect.Effect<void, ManagedFileError> =>
    service.status.pipe(
      Effect.flatMap((infos) => {
        const normalizedPaths = new Set(paths.map(normalizeManagedPath));
        const foreign = infos.find(
          (info) => normalizedPaths.has(normalizeManagedPath(info.path)) && info.owner !== ownerId,
        );
        return foreign === undefined
          ? Effect.void
          : Effect.fail(
              ownershipError(
                operation,
                foreign.path,
                `Managed file "${foreign.path}" is owned by "${foreign.owner}", not "${ownerId}".`,
              ),
            );
      }),
    );

  const withOwner = (file: PluginManagedFile): ManagedFile =>
    ({ ...file, path: normalizeManagedPath(file.path) as PortablePath, owner: ownerId }) as ManagedFile;

  const plan: PluginManagedFiles["plan"] = (files) =>
    rejectDeclaredForeignOwner(files, "plan").pipe(
      Effect.zipRight(
        assertNoForeignPath(
          files.map((file) => file.path),
          "plan",
        ),
      ),
      Effect.zipRight(service.plan(files.map(withOwner))),
    );

  const apply: PluginManagedFiles["apply"] = (files, opts) =>
    rejectDeclaredForeignOwner(files, "apply").pipe(
      Effect.zipRight(
        assertNoForeignPath(
          files.map((file) => file.path),
          "apply",
        ),
      ),
      Effect.zipRight(service.apply(files.map(withOwner), opts)),
    );

  const remove: PluginManagedFiles["remove"] = (selector = {}) => {
    const declared = ownerOf(selector);
    if (declared !== undefined && declared !== ownerId) {
      return Effect.fail(
        ownershipError(
          "remove",
          selector.path,
          `Plugin "${ownerId}" cannot remove files owned by "${String(declared)}".`,
        ),
      );
    }
    if ("base" in selector && selector.base !== undefined) {
      return Effect.fail(
        ownershipError(
          "remove",
          selector.path,
          `Plugin "${ownerId}" cannot declare a managed-file base; plugin files are rooted by the host app.`,
        ),
      );
    }
    const normalizedPath =
      selector.path === undefined ? undefined : (normalizeManagedPath(selector.path) as PortablePath);
    const scoped: ManagedFileSelector = {
      ...(selector.id === undefined ? {} : { id: selector.id }),
      ...(normalizedPath === undefined ? {} : { path: normalizedPath }),
      owner: ownerId,
    };
    const pathCheck =
      normalizedPath === undefined ? Effect.void : assertNoForeignPath([normalizedPath], "remove");
    return pathCheck.pipe(Effect.zipRight(service.remove(scoped)));
  };

  const status: PluginManagedFiles["status"] = service.status.pipe(
    Effect.map((infos) => infos.filter((info) => info.owner === ownerId)),
  );

  const adopt: PluginManagedFiles["adopt"] = (path) => {
    const normalizedPath = normalizeManagedPath(path) as PortablePath;
    return assertNoForeignPath([normalizedPath], "adopt").pipe(
      Effect.zipRight(service.adopt(normalizedPath)),
    );
  };

  const release: PluginManagedFiles["release"] = (path) => {
    const normalizedPath = normalizeManagedPath(path) as PortablePath;
    return assertNoForeignPath([normalizedPath], "release").pipe(
      Effect.zipRight(service.release(normalizedPath)),
    );
  };

  return { pluginId: ownerId, plan, apply, remove, status, adopt, release };
};

/** Constrained context a plugin receives at runtime. */
export interface LandoPluginContext {
  readonly id: string;
  readonly managedFiles: PluginManagedFiles;
  readonly stateStore: PluginStateStore;
  readonly events: {
    /**
     * Closed publish-only seam for `RenderEvent` values. Core implementations
     * redact and schema-decode before forwarding to the internal event bus.
     * Default stub fails closed until an EventService is wired by the loader.
     */
    readonly publishRender: (
      event: RenderEvent,
    ) => import("effect").Effect.Effect<void, import("@lando/sdk/errors").EventError>;
  };
}

const publishRenderNotWired = () =>
  Effect.fail(
    new EventError({
      message: "publishRender is not wired for this plugin context.",
      event: "render",
    }),
  );

/** Build a `LandoPluginContext` whose plugin host services are scoped to `id`. */
export const makeLandoPluginContext = (input: {
  readonly id: string;
  readonly managedFileService: ManagedFileServiceImpl;
  readonly stateStore: StateStoreShape;
  readonly pluginStateRoot: AbsolutePath;
  readonly publishRender?: LandoPluginContext["events"]["publishRender"];
}): LandoPluginContext => ({
  id: input.id,
  managedFiles: makePluginManagedFiles(input.id, input.managedFileService),
  stateStore: makePluginStateStore(input.stateStore, input.pluginStateRoot),
  events: {
    publishRender: input.publishRender ?? publishRenderNotWired,
  },
});
