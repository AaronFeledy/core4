// `ManagedFileServiceLive`: the single chokepoint for Lando-owned writes into
// the user's working tree. It renders + encodes content, applies an ownership
// marker (`file` mode) or a fenced region (`block` mode), records a durable
// ledger, detects drift/adoption, and refuses to silently clobber a user edit.
//
// The decision algorithm and marker handling are backend-agnostic: the service
// is built over a `ManagedFileBackend` so the real disk-backed `Live` layer and
// the in-memory `TestManagedFileStore` share one implementation. The ledger is
// realized through the generic durable JSON state bucket (not a bespoke
// registry/lock/quarantine); root resolution uses `resolveUserDataRoot()` until
// `PathsService.managedFileLedger` lands.

import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { type Context, DateTime, Effect, Layer, Option, Schema } from "effect";

import { ManagedFileError } from "@lando/sdk/errors";
import {
  ManagedFileConflictDetectedEvent,
  ManagedFileSkippedEvent,
  PostManagedFileWriteEvent,
  PreManagedFileWriteEvent,
} from "@lando/sdk/events";
import type {
  FileFormat,
  ManagedFile,
  ManagedFileAction,
  ManagedFileInfo,
  ManagedFilePlan,
  ManagedFileResult,
  PortablePath,
} from "@lando/sdk/schema";
import { createSecretRedactor } from "@lando/sdk/secrets";
import {
  EventService,
  type LandoEvent,
  type ManagedFileApplyOptions,
  type ManagedFileSelector,
  ManagedFileService,
} from "@lando/sdk/services";

import { resolveUserDataRoot } from "../config/roots.ts";
import { writeFileAtomicScoped } from "../state-store/atomic.ts";
import { type JsonBucket, openJsonBucket } from "../state-store/json-bucket.ts";
import { type ManagedFileOperation, encode as encodeFormat } from "./codecs.ts";
import {
  canCarryFileMarker,
  commentPrefix,
  composeBlock,
  composeFileContent,
  findBlock,
  hasFileMarker,
  insertBlock,
  removeBlock,
  replaceBlock,
  stripFileMarker,
} from "./marker.ts";

// ----- Ledger model -------------------------------------------------------

const LedgerEntrySchema = Schema.Struct({
  id: Schema.String,
  owner: Schema.String,
  path: Schema.String,
  mode: Schema.Literal("file", "block", "keys"),
  format: Schema.Literal("text", "env", "json", "yaml", "toml", "ini", "landofile"),
  marker: Schema.String,
  lastWrittenChecksum: Schema.String,
  sourceHash: Schema.String,
  state: Schema.Literal("managed", "adopted"),
  base: Schema.optional(Schema.String),
  backup: Schema.optional(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type LedgerEntry = typeof LedgerEntrySchema.Type;

const LedgerStateSchema = Schema.Struct({ entries: Schema.Array(LedgerEntrySchema) });
export type LedgerState = typeof LedgerStateSchema.Type;

const LEDGER_VERSION = 1;

// ----- Backend seam (disk vs in-memory) -----------------------------------

/**
 * The IO + ledger seam the service is built over. The disk `Live` backend and
 * the in-memory test backend implement it so the decision algorithm is shared.
 */
export interface ManagedFileBackend {
  /** Resolve the effective base (app root); `undefined` uses the backend default. */
  readonly resolveBase: (
    base: string | undefined,
    operation: ManagedFileOperation,
  ) => Effect.Effect<string, ManagedFileError>;
  /** Join + realpath-contain `relPath` under `base`; reject escapes with `reason:"path"`. */
  readonly resolveTarget: (
    base: string,
    relPath: string,
    operation: ManagedFileOperation,
  ) => Effect.Effect<string, ManagedFileError>;
  /** Read file content, or `null` when absent. */
  readonly readMaybe: (
    abs: string,
    operation: ManagedFileOperation,
  ) => Effect.Effect<string | null, ManagedFileError>;
  /** Atomic, interrupt-safe write; `mode` pins exact POSIX perms (e.g. `0o600` backups). */
  readonly writeAtomic: (
    abs: string,
    content: string,
    operation: ManagedFileOperation,
    mode?: number,
  ) => Effect.Effect<void, ManagedFileError>;
  /** Delete a file (no-op when absent). */
  readonly removeFile: (
    abs: string,
    operation: ManagedFileOperation,
  ) => Effect.Effect<void, ManagedFileError>;
  /** Ledger read with corruption quarantine (apply paths). */
  readonly readLedger: (
    operation: ManagedFileOperation,
  ) => Effect.Effect<ReadonlyArray<LedgerEntry>, ManagedFileError>;
  /** Side-effect-free ledger read (plan paths; never quarantines). */
  readonly peekLedger: (
    operation: ManagedFileOperation,
  ) => Effect.Effect<ReadonlyArray<LedgerEntry>, ManagedFileError>;
  /** Locked read-modify-write of the ledger. */
  readonly mutateLedger: <A>(
    operation: ManagedFileOperation,
    f: (
      entries: ReadonlyArray<LedgerEntry>,
    ) => Effect.Effect<readonly [A, ReadonlyArray<LedgerEntry>], ManagedFileError>,
  ) => Effect.Effect<A, ManagedFileError>;
  /** Replace the ledger contents. */
  readonly writeLedger: (
    entries: ReadonlyArray<LedgerEntry>,
    operation: ManagedFileOperation,
  ) => Effect.Effect<void, ManagedFileError>;
}

// ----- Event seam (redact -> publish) -------------------------------------

/**
 * The redacted-event seam the service publishes its `ManagedFile` lifecycle
 * scope through. `redactText` masks secret values out of every free-string
 * payload field BEFORE construction; `publish` forwards the content-free event
 * to the `EventService` (failures swallowed — events are observational only).
 * Both deps live in the `Live` layer closure so the frozen SDK tag is unwidened.
 */
export interface ManagedFileEvents {
  readonly redactText: (text: string) => string;
  readonly publish: (event: LandoEvent) => Effect.Effect<void>;
}

const noopManagedFileEvents: ManagedFileEvents = {
  redactText: (text) => text,
  publish: () => Effect.void,
};

type ManagedFileEventKind =
  | "pre-managed-file-write"
  | "post-managed-file-write"
  | "managed-file-conflict-detected"
  | "managed-file-skipped";

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const fail = (
  reason: ManagedFileError["reason"],
  operation: ManagedFileOperation,
  detail: { readonly path?: string; readonly remediation?: string; readonly cause?: unknown } = {},
): Effect.Effect<never, ManagedFileError> =>
  Effect.fail(new ManagedFileError({ reason, operation, ...detail }));

const isManagedFileError = (cause: unknown): cause is ManagedFileError =>
  typeof cause === "object" &&
  cause !== null &&
  "_tag" in cause &&
  (cause as { readonly _tag?: unknown })._tag === "ManagedFileError";

// ----- Content rendering --------------------------------------------------

const renderBody = (
  mf: ManagedFile,
  operation: ManagedFileOperation,
): Effect.Effect<string, ManagedFileError> => {
  const content = mf.content;
  switch (content.kind) {
    case "text":
      return Effect.succeed(content.value);
    case "structured":
      return encodeFormat(mf.format, content.data, { operation });
    case "template":
    case "inline":
      // Template/inline rendering uses `TemplateRenderer` once those content kinds
      // have callers; until then use `text` or `structured` content.
      return fail("format", operation, {
        path: mf.path,
        remediation: `\`${content.kind}\` content rendering is wired with its consumer; use \`text\` or \`structured\` content for now.`,
      });
  }
};

// ----- Decision algorithm -------------------------------------------------

interface Decision {
  readonly action: ManagedFileResult["entries"][number]["action"];
  readonly relPath: string;
  readonly abs: string;
  /** Full file content to write (apply only). */
  readonly write?: string;
  /** Ledger entry to upsert (apply only). */
  readonly ledgerNext?: LedgerEntry;
  /** Prior content to back up + relative backup path (overwrite only). */
  readonly backup?: { readonly content: string; readonly path: string };
  /** When set, apply must fail with this conflict error. */
  readonly failConflict?: boolean;
}

interface PreparedDecision {
  readonly mf: ManagedFile;
  readonly decision: Decision;
}

const nowIso = (): string => new Date().toISOString();

const buildEntry = (
  mf: ManagedFile,
  relPath: string,
  marker: string,
  lastWrittenChecksum: string,
  sourceHash: string,
  state: "managed" | "adopted",
  existing: LedgerEntry | undefined,
  backup?: string,
): LedgerEntry => ({
  id: mf.id,
  owner: mf.owner,
  path: relPath,
  mode: mf.mode,
  format: mf.format,
  marker,
  lastWrittenChecksum,
  sourceHash,
  state,
  base: mf.base,
  backup,
  createdAt: existing?.createdAt ?? nowIso(),
  updatedAt: nowIso(),
});

const resolveConflict = (mf: ManagedFile, force: boolean): "overwrite" | "skip" | "fail" => {
  const policy = mf.onConflict ?? "skip";
  if (force || policy === "overwrite") return "overwrite";
  return policy === "fail" ? "fail" : "skip";
};

const sameLedgerTarget = (
  entry: Pick<LedgerEntry, "path" | "base">,
  target: Pick<LedgerEntry, "path" | "base">,
): boolean => entry.path === target.path && entry.base === target.base;

const decideFile = (
  mf: ManagedFile,
  relPath: string,
  abs: string,
  marker: string,
  disk: string | null,
  entry: LedgerEntry | undefined,
  operation: ManagedFileOperation,
  force: boolean,
): Effect.Effect<Decision, ManagedFileError> =>
  renderBody(mf, operation).pipe(
    Effect.map((body): Decision => {
      const sourceHash = sha256(body);
      const desiredFile = composeFileContent(mf.format, marker, body);
      const desiredChecksum = sha256(desiredFile);

      if (entry?.state === "adopted") return { action: "skip-adopted", relPath, abs };
      if (disk === null) {
        return {
          action: "create",
          relPath,
          abs,
          write: desiredFile,
          ledgerNext: buildEntry(mf, relPath, marker, desiredChecksum, sourceHash, "managed", entry),
        };
      }

      const markerPresent = hasFileMarker(mf.format, disk, marker);
      if (!markerPresent) {
        if (entry?.state === "managed" && !canCarryFileMarker(mf.format, disk)) {
          const currentChecksum = sha256(disk);
          if (currentChecksum === entry.lastWrittenChecksum) {
            if (desiredChecksum === currentChecksum) {
              return {
                action: "skip-unchanged",
                relPath,
                abs,
                ledgerNext: buildEntry(mf, relPath, marker, currentChecksum, sourceHash, "managed", entry),
              };
            }
            return {
              action: "update",
              relPath,
              abs,
              write: desiredFile,
              ledgerNext: buildEntry(mf, relPath, marker, desiredChecksum, sourceHash, "managed", entry),
            };
          }
          const mode = resolveConflict(mf, force);
          if (mode === "overwrite") {
            return {
              action: "update",
              relPath,
              abs,
              write: desiredFile,
              ledgerNext: buildEntry(mf, relPath, marker, desiredChecksum, sourceHash, "managed", entry),
              backup: { content: disk, path: `${relPath}.lando-backup-${Date.now()}` },
            };
          }
          return { action: "conflict", relPath, abs, failConflict: mode === "fail" };
        }
        // Pre-existing user file, or a previously managed file whose marker was removed.
        const action: Decision["action"] = entry ? "adopt-detected" : "skip-adopted";
        return {
          action,
          relPath,
          abs,
          ledgerNext: buildEntry(mf, relPath, marker, sha256(disk), sourceHash, "adopted", entry),
        };
      }

      const currentChecksum = sha256(disk);
      const baseline = entry?.lastWrittenChecksum;
      if (desiredChecksum === currentChecksum) {
        return {
          action: "skip-unchanged",
          relPath,
          abs,
          ledgerNext: buildEntry(mf, relPath, marker, currentChecksum, sourceHash, "managed", entry),
        };
      }
      if (baseline === undefined || currentChecksum !== baseline) {
        const mode = resolveConflict(mf, force);
        if (mode === "overwrite") {
          return {
            action: "update",
            relPath,
            abs,
            write: desiredFile,
            ledgerNext: buildEntry(mf, relPath, marker, desiredChecksum, sourceHash, "managed", entry),
            backup: { content: disk, path: `${relPath}.lando-backup-${Date.now()}` },
          };
        }
        return { action: "conflict", relPath, abs, failConflict: mode === "fail" };
      }
      return {
        action: "update",
        relPath,
        abs,
        write: desiredFile,
        ledgerNext: buildEntry(mf, relPath, marker, desiredChecksum, sourceHash, "managed", entry),
      };
    }),
  );

const decideBlock = (
  mf: ManagedFile,
  relPath: string,
  abs: string,
  marker: string,
  disk: string | null,
  entry: LedgerEntry | undefined,
  operation: ManagedFileOperation,
  force: boolean,
): Effect.Effect<Decision, ManagedFileError> => {
  const prefix = commentPrefix(mf.format);
  if (prefix === null) {
    return fail("format", operation, {
      path: mf.path,
      remediation: "`block` mode needs a comment-capable format; use `file` mode for JSON.",
    });
  }
  return renderBody(mf, operation).pipe(
    Effect.map((body): Decision => {
      const sourceHash = sha256(body);
      const desiredBlock = composeBlock(prefix, marker, body);
      const desiredSliceHash = sha256(desiredBlock);
      const location =
        disk === null ? { found: false, slice: "", before: "", after: "" } : findBlock(prefix, marker, disk);

      if (entry?.state === "adopted") return { action: "skip-adopted", relPath, abs };

      if (disk === null) {
        const newContent = insertBlock(disk, desiredBlock);
        return {
          action: "create",
          relPath,
          abs,
          write: newContent,
          ledgerNext: buildEntry(mf, relPath, marker, desiredSliceHash, sourceHash, "managed", entry),
        };
      }

      if (!location.found) {
        if (entry) {
          // Previously managed, fence removed by the user -> adopted.
          return {
            action: "adopt-detected",
            relPath,
            abs,
            ledgerNext: buildEntry(
              mf,
              relPath,
              marker,
              entry.lastWrittenChecksum,
              sourceHash,
              "adopted",
              entry,
            ),
          };
        }
        return {
          action: "skip-adopted",
          relPath,
          abs,
          ledgerNext: buildEntry(mf, relPath, marker, sha256(disk), sourceHash, "adopted", entry),
        };
      }

      const currentSliceHash = sha256(location.slice);
      const baseline = entry?.lastWrittenChecksum;
      if (desiredSliceHash === currentSliceHash) {
        return {
          action: "skip-unchanged",
          relPath,
          abs,
          ledgerNext: buildEntry(mf, relPath, marker, currentSliceHash, sourceHash, "managed", entry),
        };
      }
      if (baseline === undefined || currentSliceHash !== baseline) {
        const mode = resolveConflict(mf, force);
        if (mode === "overwrite") {
          return {
            action: "update",
            relPath,
            abs,
            write: replaceBlock(location, desiredBlock),
            ledgerNext: buildEntry(mf, relPath, marker, desiredSliceHash, sourceHash, "managed", entry),
            backup: { content: location.slice, path: `${relPath}.lando-backup-${Date.now()}` },
          };
        }
        return { action: "conflict", relPath, abs, failConflict: mode === "fail" };
      }
      return {
        action: "update",
        relPath,
        abs,
        write: replaceBlock(location, desiredBlock),
        ledgerNext: buildEntry(mf, relPath, marker, desiredSliceHash, sourceHash, "managed", entry),
      };
    }),
  );
};

const decideOne = (
  backend: ManagedFileBackend,
  mf: ManagedFile,
  entries: ReadonlyArray<LedgerEntry>,
  operation: ManagedFileOperation,
  force: boolean,
  pendingDisk?: ReadonlyMap<string, string | null>,
): Effect.Effect<Decision, ManagedFileError> => {
  if (mf.mode === "keys") {
    return fail("format", operation, {
      path: mf.path,
      remediation: "`keys`-mode structured merge is not implemented yet; use `file` or `block`.",
    });
  }
  const marker = mf.marker ?? mf.id;
  return Effect.gen(function* () {
    const base = yield* backend.resolveBase(mf.base, operation);
    const abs = yield* backend.resolveTarget(base, mf.path, operation);
    const disk = pendingDisk?.has(abs)
      ? (pendingDisk.get(abs) ?? null)
      : yield* backend.readMaybe(abs, operation);
    const entry = entries.find((candidate) => sameLedgerTarget(candidate, { path: mf.path, base: mf.base }));
    const decision =
      mf.mode === "file"
        ? decideFile(mf, mf.path, abs, marker, disk, entry, operation, force)
        : decideBlock(mf, mf.path, abs, marker, disk, entry, operation, force);
    return yield* decision;
  });
};

// ----- Service factory ----------------------------------------------------

const upsertEntry = (entries: ReadonlyArray<LedgerEntry>, next: LedgerEntry): ReadonlyArray<LedgerEntry> => [
  ...entries.filter((entry) => !sameLedgerTarget(entry, next)),
  next,
];

const matchesRemoveSelector = (entry: LedgerEntry, selector: ManagedFileSelector): boolean =>
  entry.state === "managed" &&
  (selector.owner === undefined || entry.owner === selector.owner) &&
  (selector.id === undefined || entry.id === selector.id) &&
  (selector.path === undefined || entry.path === selector.path) &&
  (selector.base === undefined
    ? selector.path === undefined || entry.base === undefined
    : entry.base === selector.base);

const eventSummary = (mf: ManagedFile, decision: Decision): string => {
  const bytes = decision.write !== undefined ? ` (${Buffer.byteLength(decision.write, "utf8")}B)` : "";
  const backedUp = decision.backup ? " [prior content backed up]" : "";
  return `${decision.action} ${mf.mode}/${mf.format}${bytes}${backedUp}`;
};

const makeLifecycleEvent = (
  kind: ManagedFileEventKind,
  fields: {
    readonly path: PortablePath;
    readonly owner: string;
    readonly action: ManagedFileAction;
    readonly summary: string;
  },
): LandoEvent => {
  const timestamp = DateTime.unsafeMake(Date.now());
  const payload = { eventName: kind, ...fields, timestamp } as const;
  switch (kind) {
    case "pre-managed-file-write":
      return PreManagedFileWriteEvent.make({ ...payload, eventName: "pre-managed-file-write" });
    case "post-managed-file-write":
      return PostManagedFileWriteEvent.make({ ...payload, eventName: "post-managed-file-write" });
    case "managed-file-conflict-detected":
      return ManagedFileConflictDetectedEvent.make({
        ...payload,
        eventName: "managed-file-conflict-detected",
      });
    case "managed-file-skipped":
      return ManagedFileSkippedEvent.make({ ...payload, eventName: "managed-file-skipped" });
  }
};

export const makeManagedFileService = (
  backend: ManagedFileBackend,
  events: ManagedFileEvents = noopManagedFileEvents,
): Effect.Effect<Context.Tag.Service<typeof ManagedFileService>> =>
  Effect.sync(() => {
    const publishLifecycle = (
      kind: ManagedFileEventKind,
      mf: ManagedFile,
      decision: Decision,
    ): Effect.Effect<void> =>
      events.publish(
        makeLifecycleEvent(kind, {
          path: events.redactText(decision.relPath) as PortablePath,
          owner: events.redactText(mf.owner),
          action: decision.action,
          summary: events.redactText(eventSummary(mf, decision)),
        }),
      );
    const plan = (files: ReadonlyArray<ManagedFile>): Effect.Effect<ManagedFilePlan, ManagedFileError> =>
      backend.peekLedger("plan").pipe(
        Effect.flatMap((initial) =>
          Effect.gen(function* () {
            let entries = initial;
            const pendingDisk = new Map<string, string | null>();
            const results: Array<ManagedFilePlan["entries"][number]> = [];
            for (const mf of files) {
              const decision = yield* decideOne(backend, mf, entries, "plan", false, pendingDisk);
              if (decision.ledgerNext) entries = upsertEntry(entries, decision.ledgerNext);
              if (decision.write !== undefined) pendingDisk.set(decision.abs, decision.write);
              results.push({
                id: mf.id,
                path: decision.relPath as PortablePath,
                action: decision.action,
              });
            }
            return { entries: results };
          }),
        ),
      );

    const apply = (
      files: ReadonlyArray<ManagedFile>,
      opts?: ManagedFileApplyOptions,
    ): Effect.Effect<ManagedFileResult, ManagedFileError> =>
      backend.mutateLedger("apply", (initial) =>
        Effect.gen(function* () {
          let entries = initial;
          const pendingDisk = new Map<string, string | null>();
          const prepared: Array<PreparedDecision> = [];
          const results: Array<ManagedFileResult["entries"][number]> = [];
          for (const mf of files) {
            const decision = yield* decideOne(
              backend,
              mf,
              entries,
              "apply",
              opts?.force ?? false,
              pendingDisk,
            );
            if (decision.failConflict) {
              yield* publishLifecycle("managed-file-conflict-detected", mf, decision);
              return yield* fail("conflict", "apply", {
                path: decision.relPath,
                remediation:
                  "The managed file was edited in place; resolve the conflict or pass `force` to overwrite.",
              });
            }
            const backup = decision.backup?.path as PortablePath | undefined;
            if (decision.ledgerNext) {
              entries = upsertEntry(
                entries,
                decision.backup
                  ? { ...decision.ledgerNext, backup: decision.backup.path }
                  : decision.ledgerNext,
              );
            }
            if (decision.write !== undefined) pendingDisk.set(decision.abs, decision.write);
            prepared.push({ mf, decision });
            results.push({
              id: mf.id,
              path: decision.relPath as PortablePath,
              action: decision.action,
              backup,
            });
          }
          for (const { mf, decision } of prepared) {
            if (decision.backup) {
              yield* publishLifecycle("managed-file-conflict-detected", mf, decision);
            }
            if (decision.write === undefined) {
              if (
                decision.action === "skip-unchanged" ||
                decision.action === "skip-adopted" ||
                decision.action === "adopt-detected"
              ) {
                yield* publishLifecycle("managed-file-skipped", mf, decision);
              } else if (decision.action === "conflict") {
                yield* publishLifecycle("managed-file-conflict-detected", mf, decision);
              }
              continue;
            }
            yield* publishLifecycle("pre-managed-file-write", mf, decision);
            if (decision.backup) {
              const backupAbs = yield* backend.resolveTarget(
                yield* backend.resolveBase(mf.base, "apply"),
                decision.backup.path,
                "apply",
              );
              yield* backend.writeAtomic(backupAbs, decision.backup.content, "apply", 0o600);
            }
            yield* backend.writeAtomic(decision.abs, decision.write, "apply");
            yield* publishLifecycle("post-managed-file-write", mf, decision);
          }
          return [{ entries: results }, entries] as const;
        }),
      );

    const remove = (selector: ManagedFileSelector): Effect.Effect<ManagedFileResult, ManagedFileError> =>
      backend.mutateLedger("remove", (entries) =>
        Effect.gen(function* () {
          const matches = entries.filter((entry) => matchesRemoveSelector(entry, selector));
          const results: Array<ManagedFileResult["entries"][number]> = [];
          let next = entries;
          for (const entry of matches) {
            const base = yield* backend.resolveBase(entry.base, "remove");
            const abs = yield* backend.resolveTarget(base, entry.path, "remove");
            if (entry.mode === "block") {
              const disk = yield* backend.readMaybe(abs, "remove");
              if (disk !== null) {
                const prefix = commentPrefix(entry.format) ?? "#";
                const location = findBlock(prefix, entry.marker, disk);
                if (location.found) yield* backend.writeAtomic(abs, removeBlock(location), "remove");
              }
            } else {
              yield* backend.removeFile(abs, "remove");
            }
            next = next.filter((candidate) => !sameLedgerTarget(candidate, entry));
            results.push({ id: entry.id, path: entry.path as PortablePath, action: "update" });
          }
          return [{ entries: results }, next] as const;
        }),
      );

    const status: Effect.Effect<ReadonlyArray<ManagedFileInfo>, ManagedFileError> = Effect.suspend(() =>
      backend.peekLedger("status").pipe(
        Effect.flatMap((entries) =>
          Effect.forEach(entries, (entry) =>
            backend.resolveBase(entry.base, "status").pipe(
              Effect.flatMap((base) => backend.resolveTarget(base, entry.path, "status")),
              Effect.flatMap((abs) => backend.readMaybe(abs, "status")),
              Effect.map(
                (disk): ManagedFileInfo => ({
                  path: entry.path as PortablePath,
                  owner: entry.owner,
                  mode: entry.mode,
                  state: computeState(entry, disk),
                }),
              ),
            ),
          ),
        ),
      ),
    );

    const adopt = (path: PortablePath): Effect.Effect<void, ManagedFileError> =>
      backend.mutateLedger("adopt", (entries) =>
        Effect.gen(function* () {
          const entry = entries.find((candidate) => sameLedgerTarget(candidate, { path, base: undefined }));
          const base = yield* backend.resolveBase(entry?.base, "adopt");
          const abs = yield* backend.resolveTarget(base, path, "adopt");
          const disk = yield* backend.readMaybe(abs, "adopt");
          if (disk !== null && entry) {
            const stripped =
              entry.mode === "block"
                ? stripBlockFences(entry.format, entry.marker, disk)
                : stripFileMarker(entry.format, disk, entry.marker);
            if (stripped !== disk) yield* backend.writeAtomic(abs, stripped, "adopt");
          }
          const next = entry
            ? upsertEntry(entries, { ...entry, state: "adopted", updatedAt: nowIso() })
            : entries;
          return [undefined, next] as const;
        }),
      );

    const release = (path: PortablePath): Effect.Effect<void, ManagedFileError> =>
      backend.mutateLedger("release", (entries) => {
        const entry = entries.find((candidate) => sameLedgerTarget(candidate, { path, base: undefined }));
        return Effect.succeed([
          undefined,
          entry ? upsertEntry(entries, { ...entry, state: "adopted", updatedAt: nowIso() }) : entries,
        ] as const);
      });

    return { plan, apply, remove, status, adopt, release } satisfies Context.Tag.Service<
      typeof ManagedFileService
    >;
  });

const stripBlockFences = (format: FileFormat, marker: string, content: string): string => {
  const prefix = commentPrefix(format) ?? "#";
  const location = findBlock(prefix, marker, content);
  if (!location.found) return content;
  const inner = location.slice.split(/\r?\n/u).slice(1, -1).join("\n");
  const before = location.before === "" ? "" : `${location.before}\n`;
  const after = location.after === "" ? "" : `\n${location.after.replace(/^\n+/u, "")}`;
  return `${before}${inner}${after}`.replace(/\n*$/u, "\n");
};

const computeState = (entry: LedgerEntry, disk: string | null): ManagedFileInfo["state"] => {
  if (disk === null) return "missing";
  if (entry.state === "adopted") return "adopted";
  if (entry.mode === "block") {
    const prefix = commentPrefix(entry.format) ?? "#";
    const location = findBlock(prefix, entry.marker, disk);
    if (!location.found) return "adopted";
    return sha256(location.slice) === entry.lastWrittenChecksum ? "managed" : "conflict";
  }
  if (!hasFileMarker(entry.format, disk, entry.marker) && canCarryFileMarker(entry.format, disk))
    return "adopted";
  return sha256(disk) === entry.lastWrittenChecksum ? "managed" : "conflict";
};

// ----- Disk-backed Live backend + Layer -----------------------------------

const containmentError = (operation: ManagedFileOperation, path: string): ManagedFileError =>
  new ManagedFileError({
    reason: "path",
    operation,
    path,
    remediation: "Managed-file paths must stay inside the resolved base (app root).",
  });

const resolveContained = async (base: string, relPath: string): Promise<string | null> => {
  if (isAbsolute(relPath)) return null;
  const target = resolve(base, relPath);
  const realBase = await realpathOrSelf(base);
  const real = (await realpathIfExists(target)) ?? (await resolveMissingTargetRealPath(target));
  const rel = relative(realBase, real);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return target;
};

const realpathOrSelf = async (path: string): Promise<string> => {
  const { realpath } = await import("node:fs/promises");
  return realpath(path).catch(() => path);
};

const realpathIfExists = async (path: string): Promise<string | null> => {
  const { realpath } = await import("node:fs/promises");
  return realpath(path).catch((cause: { code?: string }) => {
    if (cause.code === "ENOENT" || cause.code === "ENOTDIR") return null;
    throw cause;
  });
};

const resolveMissingTargetRealPath = async (target: string): Promise<string> => {
  let ancestor = dirname(target);
  while (true) {
    const realAncestor = await realpathIfExists(ancestor);
    if (realAncestor !== null) return resolve(realAncestor, relative(ancestor, target));
    const parent = dirname(ancestor);
    if (parent === ancestor) return target;
    ancestor = parent;
  }
};

/** Build the disk-backed backend rooted at `cwd` with the ledger under userData. */
export const makeDiskBackend = (options: {
  readonly defaultBase: () => string;
  readonly ledgerRoot: () => string;
}): Effect.Effect<ManagedFileBackend> =>
  Effect.gen(function* () {
    const ledgerBucketFor = (base: string): Effect.Effect<JsonBucket<LedgerState>> =>
      openJsonBucket({
        dir: join(options.ledgerRoot(), "managed-files", deriveAppId(base)),
        key: "ledger.json",
        version: LEDGER_VERSION,
        schema: LedgerStateSchema,
        lock: "advisory",
        onCorrupt: "quarantine",
        default: { entries: [] },
      });

    const ledgerEntries = (
      mutate: boolean,
      operation: ManagedFileOperation,
    ): Effect.Effect<ReadonlyArray<LedgerEntry>, ManagedFileError> =>
      ledgerBucketFor(options.defaultBase()).pipe(
        Effect.flatMap((bucket) => (mutate ? bucket.get : bucket.peek)),
        Effect.map((state) => state?.entries ?? []),
        Effect.mapError((cause) => new ManagedFileError({ reason: "io", operation, cause })),
      );

    return {
      resolveBase: (base) => Effect.succeed(base ?? options.defaultBase()),
      resolveTarget: (base, relPath, operation) =>
        Effect.tryPromise({
          try: () => resolveContained(base, relPath),
          catch: (cause) => new ManagedFileError({ reason: "io", operation, path: relPath, cause }),
        }).pipe(
          Effect.flatMap((abs) =>
            abs === null ? Effect.fail(containmentError(operation, relPath)) : Effect.succeed(abs),
          ),
        ),
      readMaybe: (abs, operation) =>
        Effect.tryPromise({
          try: async () => {
            const { readFile } = await import("node:fs/promises");
            return (await readFile(abs, "utf8")) as string;
          },
          catch: (cause) =>
            (cause as { code?: string }).code === "ENOENT"
              ? new ManagedFileError({ reason: "io", operation, path: abs, cause: "ENOENT" })
              : new ManagedFileError({ reason: "io", operation, path: abs, cause }),
        }).pipe(
          Effect.catchIf(
            (error) => error.cause === "ENOENT",
            () => Effect.succeed<string | null>(null),
          ),
        ),
      writeAtomic: (abs, content, operation, mode) =>
        writeFileAtomicScoped(abs, content, mode === undefined ? {} : { mode }).pipe(
          Effect.mapError((cause) => new ManagedFileError({ reason: "io", operation, path: abs, cause })),
        ),
      removeFile: (abs, operation) =>
        Effect.tryPromise({
          try: async () => {
            const { unlink } = await import("node:fs/promises");
            await unlink(abs).catch((cause: { code?: string }) => {
              if (cause.code !== "ENOENT") throw cause;
            });
          },
          catch: (cause) => new ManagedFileError({ reason: "io", operation, path: abs, cause }),
        }),
      readLedger: (operation) => ledgerEntries(true, operation),
      peekLedger: (operation) => ledgerEntries(false, operation),
      mutateLedger: (operation, f) =>
        ledgerBucketFor(options.defaultBase()).pipe(
          Effect.flatMap((bucket) =>
            bucket.modify((state) =>
              f(state?.entries ?? []).pipe(Effect.map(([result, entries]) => [result, { entries }] as const)),
            ),
          ),
          Effect.mapError((cause) =>
            isManagedFileError(cause) ? cause : new ManagedFileError({ reason: "io", operation, cause }),
          ),
        ),
      writeLedger: (entries, operation) =>
        ledgerBucketFor(options.defaultBase()).pipe(
          Effect.flatMap((bucket) => bucket.set({ entries })),
          Effect.mapError((cause) => new ManagedFileError({ reason: "io", operation, cause })),
        ),
    } satisfies ManagedFileBackend;
  });

const deriveAppId = (base: string): string => {
  const name = (base.split(/[\\/]/u).filter(Boolean).pop() ?? "app").replace(/[^A-Za-z0-9._-]/gu, "-");
  return `${name}-${sha256(resolve(base)).slice(0, 12)}`;
};

const makeLiveManagedFileEvents = (
  eventService: Option.Option<Context.Tag.Service<typeof EventService>>,
): ManagedFileEvents => {
  // `@lando/sdk/secrets` value redactor; value-set may be empty until a global
  // redaction feed is wired — content-free payloads still prevent secret leaks.
  const { redact } = createSecretRedactor([]);
  return {
    redactText: redact,
    publish: Option.match(eventService, {
      onNone: () => () => Effect.void,
      onSome:
        (service) =>
        (event): Effect.Effect<void> =>
          service.publish(event).pipe(Effect.catchAllCause(() => Effect.void)),
    }),
  };
};

/**
 * The disk-backed `ManagedFileService` layer, available at bootstrap `minimal`.
 * Constructing it touches no provider, network, or plugin module. `EventService`
 * is resolved optionally from the layer build context (the bootstrap layer
 * `Layer.provide`s it) so library callers without an `EventService` still work.
 */
export const ManagedFileServiceLive: Layer.Layer<ManagedFileService> = Layer.effect(
  ManagedFileService,
  Effect.gen(function* () {
    const backend = yield* makeDiskBackend({
      defaultBase: () => process.cwd(),
      ledgerRoot: () => resolveUserDataRoot(),
    });
    const eventService = yield* Effect.serviceOption(EventService);
    return yield* makeManagedFileService(backend, makeLiveManagedFileEvents(eventService));
  }),
);
