import { type Context, Effect, Either, Fiber } from "effect";

import type { ManagedFileError } from "../errors/index.ts";
import type {
  AbsolutePath,
  ManagedFile,
  ManagedFileInfo,
  ManagedFilePlan,
  ManagedFileResult,
  PortablePath,
} from "../schema/index.ts";
import type { LandoEvent, ManagedFileService } from "../services/index.ts";
import { ContractFailure } from "./_shared.ts";

const managedFileContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({
    message: `ManagedFileService contract failed: ${assertion}`,
    assertion,
    details,
  });

const requireManagedFileContract = (condition: boolean, assertion: string, details?: unknown) =>
  condition ? Effect.void : Effect.fail(managedFileContractFailure(assertion, details));

const MANAGED_FILE_CONTRACT_OWNER = "contract";

/**
 * A backend-agnostic view of a `ManagedFileService` implementation that the
 * managed-file contract suite drives. `service` is the implementation under
 * test; `base` is the resolved app root the suite stamps onto every
 * `ManagedFile`; `read`/`seed` inspect and pre-populate the working tree
 * relative to `base`; `events` returns every `ManagedFile` lifecycle event
 * emitted so far. The same suite runs against `ManagedFileServiceLive`,
 * `TestManagedFileStore`, and any host or test override of the service.
 */
export interface ManagedFileContractHarness {
  readonly name?: string;
  readonly service: Context.Tag.Service<typeof ManagedFileService>;
  readonly base: AbsolutePath;
  readonly read: (path: PortablePath) => Effect.Effect<string | null>;
  readonly seed: (path: PortablePath, content: string) => Effect.Effect<void>;
  readonly events: () => Effect.Effect<ReadonlyArray<LandoEvent>>;
}

const MANAGED_FILE_CONTRACT_FORMATS = [
  { format: "text", ext: "txt", content: { kind: "text", value: "alpha=1\n" } },
  { format: "env", ext: "env", content: { kind: "structured", data: { ALPHA: "1" } } },
  { format: "json", ext: "json", content: { kind: "structured", data: { alpha: 1 } } },
  { format: "yaml", ext: "yaml", content: { kind: "structured", data: { alpha: 1 } } },
  { format: "javascript", ext: "js", content: { kind: "text", value: "export const alpha = 1;\n" } },
  { format: "typescript", ext: "ts", content: { kind: "text", value: "export const alpha = 1;\n" } },
] as const;

// No per-file `base` override: `adopt`/`release`/`remove({ path })` look up
// ledger entries with `base: undefined`, so a stamped base would break them.
const managedContractTextFile = (
  path: string,
  value: string,
  overrides: Partial<ManagedFile> = {},
): ManagedFile => ({
  id: `contract:${path}`,
  owner: MANAGED_FILE_CONTRACT_OWNER,
  path: path as PortablePath,
  mode: "file",
  format: "text",
  content: { kind: "text", value },
  ...overrides,
});

/**
 * Run the `ManagedFileService` contract assertions against a harness. Asserts
 * (in order): plan/apply agree on create; update replaces content; identical
 * re-apply is skip-unchanged; an in-place user edit reports a conflict; a path
 * escaping the base is rejected (`reason: "path"`); `adopt` makes a file
 * adopted and re-apply skip-adopted; `release` marks a file adopted; `remove`
 * deletes a managed file and a repeat remove is a no-op; the ownership marker
 * round-trips per supported format (re-apply is skip-unchanged); `block` mode
 * is idempotent and preserves user content; an interrupted update leaves the
 * file fully old or fully new (never torn); and a secret in managed content
 * never appears in an emitted event.
 */
export const runManagedFileContract = (
  harness: ManagedFileContractHarness,
): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    const service = harness.service;
    const apply = (files: ReadonlyArray<ManagedFile>): Effect.Effect<ManagedFileResult, ManagedFileError> =>
      Effect.scoped(service.apply(files));
    const failWith =
      (assertion: string) =>
      (cause: unknown): ContractFailure =>
        managedFileContractFailure(assertion, cause);

    // 1. plan matches apply (create) + status reflects a managed file.
    const createFile = managedContractTextFile("create.txt", "v1\n");
    const plan: ManagedFilePlan = yield* service
      .plan([createFile])
      .pipe(Effect.mapError(failWith("plan resolves for a new file")));
    const created = yield* apply([createFile]).pipe(Effect.mapError(failWith("apply creates a new file")));
    yield* requireManagedFileContract(
      plan.entries[0]?.action === "create" && created.entries[0]?.action === "create",
      "plan and apply agree the first write is a create",
      { plan: plan.entries, apply: created.entries },
    );
    const createdContent = yield* harness.read("create.txt" as PortablePath);
    yield* requireManagedFileContract(
      createdContent !== null,
      "the created file exists in the working tree",
      createdContent,
    );
    const statusAfterCreate = yield* service.status.pipe(Effect.mapError(failWith("status resolves")));
    yield* requireManagedFileContract(
      statusAfterCreate.some(
        (info: ManagedFileInfo) =>
          info.path === "create.txt" &&
          info.owner === MANAGED_FILE_CONTRACT_OWNER &&
          info.state === "managed",
      ),
      "status reports the created file as managed",
      statusAfterCreate,
    );

    // 2. update replaces prior content wholesale.
    const updateFile = managedContractTextFile("create.txt", "v2\n");
    const updated = yield* apply([updateFile]).pipe(
      Effect.mapError(failWith("apply updates a managed file")),
    );
    yield* requireManagedFileContract(
      updated.entries[0]?.action === "update",
      "changed content yields an update",
      updated.entries,
    );
    const updatedContent = yield* harness.read("create.txt" as PortablePath);
    yield* requireManagedFileContract(
      updatedContent?.includes("v2") === true && updatedContent.includes("v1") === false,
      "an update replaces the prior managed content",
      updatedContent,
    );

    // 3. identical re-apply is skip-unchanged.
    const skipped = yield* apply([updateFile]).pipe(Effect.mapError(failWith("re-apply resolves")));
    yield* requireManagedFileContract(
      skipped.entries[0]?.action === "skip-unchanged",
      "an identical re-apply is skip-unchanged",
      skipped.entries,
    );

    // 4. an in-place user edit is reported as a conflict.
    yield* harness.seed("create.txt" as PortablePath, `${updatedContent ?? ""}tampered\n`);
    const conflicted = yield* apply([updateFile]).pipe(
      Effect.mapError(failWith("apply over a user edit resolves")),
    );
    yield* requireManagedFileContract(
      conflicted.entries[0]?.action === "conflict",
      "an in-place user edit is reported as a conflict",
      conflicted.entries,
    );

    // 5. a path escaping the base is rejected with reason "path".
    const escapeFile = managedContractTextFile("../escape.txt", "nope\n");
    const escapeResult = yield* Effect.either(apply([escapeFile]));
    yield* requireManagedFileContract(
      Either.isLeft(escapeResult) && escapeResult.left.reason === "path",
      "a path escaping the base is rejected with reason path",
      escapeResult,
    );

    // 6. adopt + skip-adopted.
    const adoptFile = managedContractTextFile("adopt.txt", "a1\n");
    yield* apply([adoptFile]).pipe(Effect.mapError(failWith("apply creates the adopt fixture")));
    yield* service.adopt("adopt.txt" as PortablePath).pipe(Effect.mapError(failWith("adopt resolves")));
    const adoptStatus = yield* service.status.pipe(Effect.mapError(failWith("status resolves after adopt")));
    yield* requireManagedFileContract(
      adoptStatus.some((info: ManagedFileInfo) => info.path === "adopt.txt" && info.state === "adopted"),
      "adopt marks the file adopted",
      adoptStatus,
    );
    const skipAdopted = yield* apply([adoptFile]).pipe(
      Effect.mapError(failWith("re-apply after adopt resolves")),
    );
    yield* requireManagedFileContract(
      skipAdopted.entries[0]?.action === "skip-adopted",
      "a re-apply after adopt is skip-adopted",
      skipAdopted.entries,
    );

    // 7. release marks a file adopted.
    const releaseFile = managedContractTextFile("release.txt", "r1\n");
    yield* apply([releaseFile]).pipe(Effect.mapError(failWith("apply creates the release fixture")));
    yield* service.release("release.txt" as PortablePath).pipe(Effect.mapError(failWith("release resolves")));
    const releaseStatus = yield* service.status.pipe(
      Effect.mapError(failWith("status resolves after release")),
    );
    yield* requireManagedFileContract(
      releaseStatus.some((info: ManagedFileInfo) => info.path === "release.txt" && info.state === "adopted"),
      "release marks the file adopted",
      releaseStatus,
    );

    // 8. remove deletes the file; a repeat remove is a no-op.
    const removeFile = managedContractTextFile("remove.txt", "x1\n");
    yield* apply([removeFile]).pipe(Effect.mapError(failWith("apply creates the remove fixture")));
    const removed = yield* service
      .remove({ owner: MANAGED_FILE_CONTRACT_OWNER, path: "remove.txt" as PortablePath })
      .pipe(Effect.mapError(failWith("remove resolves")));
    yield* requireManagedFileContract(
      removed.entries.length >= 1,
      "remove reports the removed entry",
      removed.entries,
    );
    const afterRemove = yield* harness.read("remove.txt" as PortablePath);
    yield* requireManagedFileContract(
      afterRemove === null,
      "a removed managed file is gone from the working tree",
      afterRemove,
    );
    const removeAgain = yield* service
      .remove({ owner: MANAGED_FILE_CONTRACT_OWNER, path: "remove.txt" as PortablePath })
      .pipe(Effect.mapError(failWith("a repeat remove resolves")));
    yield* requireManagedFileContract(
      removeAgain.entries.length === 0,
      "removing an already-removed file is a no-op",
      removeAgain.entries,
    );

    // 9. the ownership marker round-trips per supported format.
    for (const spec of MANAGED_FILE_CONTRACT_FORMATS) {
      const formatPath = `marker-${spec.format}.${spec.ext}`;
      const formatFile: ManagedFile = {
        id: `contract:fmt:${spec.format}`,
        owner: MANAGED_FILE_CONTRACT_OWNER,
        path: formatPath as PortablePath,
        mode: "file",
        format: spec.format,
        content: spec.content,
      };
      const createdFormat = yield* apply([formatFile]).pipe(
        Effect.mapError(failWith(`apply creates a ${spec.format} file`)),
      );
      yield* requireManagedFileContract(
        createdFormat.entries[0]?.action === "create",
        `format ${spec.format} is created`,
        createdFormat.entries,
      );
      const formatContent = yield* harness.read(formatPath as PortablePath);
      yield* requireManagedFileContract(
        formatContent !== null,
        `format ${spec.format} writes content`,
        formatContent,
      );
      const reappliedFormat = yield* apply([formatFile]).pipe(
        Effect.mapError(failWith(`re-apply for a ${spec.format} file resolves`)),
      );
      yield* requireManagedFileContract(
        reappliedFormat.entries[0]?.action === "skip-unchanged",
        `format ${spec.format} marker round-trips to skip-unchanged`,
        reappliedFormat.entries,
      );
    }

    // 10. block mode injects a fenced region into a file Lando creates, is
    // idempotent, and preserves user content added around the fence. A
    // pre-existing fence-less file is adopted, never appended, so the block is
    // created on a new path first.
    const blockFile = managedContractTextFile("block.txt", "managed block line\n", {
      mode: "block",
      marker: "contract-block",
    });
    const blockFirst = yield* apply([blockFile]).pipe(
      Effect.mapError(failWith("apply inserts a managed block")),
    );
    yield* requireManagedFileContract(
      blockFirst.entries[0]?.action === "create",
      "the first block apply creates the fenced region",
      blockFirst.entries,
    );
    const blockCreated = yield* harness.read("block.txt" as PortablePath);
    yield* harness.seed(
      "block.txt" as PortablePath,
      `# user header line\n${blockCreated ?? ""}# user footer line\n`,
    );
    const blockReapply = yield* apply([blockFile]).pipe(
      Effect.mapError(failWith("re-apply of a managed block resolves")),
    );
    yield* requireManagedFileContract(
      blockReapply.entries[0]?.action === "skip-unchanged",
      "block mode re-apply is idempotent (skip-unchanged)",
      blockReapply.entries,
    );
    const blockContent = yield* harness.read("block.txt" as PortablePath);
    const fenceOpens = (blockContent ?? "").split(">>> lando:contract-block").length - 1;
    yield* requireManagedFileContract(
      fenceOpens === 1 &&
        (blockContent ?? "").includes("user header line") &&
        (blockContent ?? "").includes("user footer line"),
      "block mode keeps exactly one fenced region and preserves user content",
      { fenceOpens, blockContent },
    );

    // 11. an interrupted update leaves the file fully old or fully new (never torn).
    const atomicFile = managedContractTextFile("atomic.txt", "alpha\n");
    yield* apply([atomicFile]).pipe(Effect.mapError(failWith("apply creates the atomic fixture")));
    const atomicBeta = managedContractTextFile("atomic.txt", "beta\n");
    yield* apply([atomicBeta]).pipe(Effect.mapError(failWith("apply updates the atomic fixture")));
    const beforeInterrupt = yield* harness.read("atomic.txt" as PortablePath);
    const atomicGamma = managedContractTextFile("atomic.txt", "gamma\n");
    const fiber = yield* Effect.fork(apply([atomicGamma]));
    yield* Fiber.interrupt(fiber);
    const afterInterrupt = yield* harness.read("atomic.txt" as PortablePath);
    const interruptedFileIsTorn =
      afterInterrupt === null ||
      !afterInterrupt.endsWith("\n") ||
      (afterInterrupt !== beforeInterrupt &&
        !(afterInterrupt.includes("gamma") && !afterInterrupt.includes("beta")));
    yield* requireManagedFileContract(
      !interruptedFileIsTorn,
      "an interrupted update leaves the file fully old or fully new, never torn",
      { beforeInterrupt, afterInterrupt },
    );

    // 12. a secret in managed content never appears in an emitted event.
    const secret = "ULW-MANAGED-SECRET-d41d8cd9f00b204e";
    const secretFile = managedContractTextFile("secret.txt", `token=${secret}\n`);
    yield* apply([secretFile]).pipe(Effect.mapError(failWith("apply of a secret-bearing file resolves")));
    const emitted = yield* harness.events();
    yield* requireManagedFileContract(emitted.length > 0, "apply emits lifecycle events", emitted.length);
    yield* requireManagedFileContract(
      !JSON.stringify(emitted).includes(secret),
      "a secret in managed content never appears in an emitted event",
      { sampleEvent: emitted[0] },
    );
    const secretOnDisk = yield* harness.read("secret.txt" as PortablePath);
    yield* requireManagedFileContract(
      secretOnDisk?.includes(secret) === true,
      "the secret is written to the working tree (sanity)",
      secretOnDisk,
    );
  });
