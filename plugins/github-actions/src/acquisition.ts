import { constants } from "node:fs";
import { lstat, open, opendir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { Context, Effect, Layer, type Scope } from "effect";
import { type BoundedReader, readBounded } from "./bounded-read.ts";
import { diagnostic, limits, location } from "./diagnostics.ts";
import { type GithubActionsWorkflowError, workflowError } from "./errors.ts";
import type { ListWorkflowsOptions, WorkflowDiagnostic } from "./schema.ts";

export interface Inventory {
  readonly root: string;
  readonly names: readonly string[];
}
export type AcquiredFile =
  | { readonly status: "read"; readonly content: string; readonly bytes: number }
  | { readonly status: "failed"; readonly diagnostic: WorkflowDiagnostic; readonly bytes: number };

const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";
const io = <A>(run: () => Promise<A>, error: GithubActionsWorkflowError) =>
  Effect.tryPromise({ try: run, catch: () => error });
const close = (run: () => Promise<unknown>) =>
  Effect.tryPromise({ try: run, catch: () => workflowError("unreadable-directory") }).pipe(Effect.orDie);

const checkDirectories = Effect.fn("WorkflowAcquisition.checkDirectories")(function* (root: string) {
  for (const path of [join(root, ".github"), join(root, ".github/workflows")]) {
    const info = yield* Effect.tryPromise({
      try: () => lstat(path),
      catch: (error) => (missing(error) ? ("missing" as const) : workflowError("unreadable-directory")),
    }).pipe(
      Effect.catchIf(
        (error) => error === "missing",
        () => Effect.succeed(undefined),
      ),
    );
    if (info === undefined) return false;
    if (info.isSymbolicLink() || !info.isDirectory()) return yield* workflowError("unsafe-directory");
    if ((yield* io(() => realpath(path), workflowError("unsafe-directory"))) !== path)
      return yield* workflowError("unsafe-directory");
  }
  return true;
});

const discover = Effect.fn("WorkflowAcquisition.discover")(function* (options: ListWorkflowsOptions) {
  const root = yield* io(() => realpath(options.root), workflowError("invalid-root"));
  if (!(yield* io(() => stat(root), workflowError("invalid-root"))).isDirectory())
    return yield* workflowError("invalid-root");
  const present = yield* checkDirectories(root);
  const workflow = options.workflow;
  if (!present) {
    if (workflow !== undefined) return yield* workflowError("workflow-not-found");
    return { root, names: [] };
  }
  if (workflow !== undefined) {
    yield* io(() => lstat(join(root, workflow)), workflowError("workflow-not-found"));
    return { root, names: [workflow] };
  }
  const names = yield* Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        io(() => opendir(join(root, ".github/workflows")), workflowError("unreadable-directory")),
        (handle) => close(() => handle.close()),
      );
      const found: string[] = [];
      let count = 0;
      for (;;) {
        const entry = yield* io(() => directory.read(), workflowError("unreadable-directory"));
        if (entry === null) break;
        if (++count > limits.entries) return yield* workflowError("inventory-limit");
        if (!/\.ya?ml$/u.test(entry.name)) continue;
        found.push(`.github/workflows/${entry.name}`);
        if (found.length > limits.files) return yield* workflowError("inventory-limit");
      }
      return found.sort();
    }),
  );
  return { root, names };
});

const readFile = Effect.fn("WorkflowAcquisition.read")(function* (
  inventory: Inventory,
  name: string,
  remainingBytes: number,
) {
  const source = location(name);
  let chargedBytes = 0;
  const failure = (code: "unsafe-file" | "unreadable-file" | "file-limit"): AcquiredFile => ({
    status: "failed",
    diagnostic: diagnostic(code, source),
    bytes: chargedBytes,
  });
  const directories = yield* checkDirectories(inventory.root).pipe(Effect.result);
  if (directories._tag === "Failure" || !directories.success) return failure("unsafe-file");
  const path = join(inventory.root, name);
  const attempt: Effect.Effect<AcquiredFile, "unsafe-file" | "unreadable-file", Scope.Scope> = Effect.gen(
    function* () {
      const before = yield* Effect.tryPromise({
        try: () => lstat(path),
        catch: () => "unreadable-file" as const,
      });
      if (!before.isFile() || before.isSymbolicLink()) return failure("unsafe-file");
      const handle = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
          catch: () => "unsafe-file" as const,
        }),
        (file) => close(() => file.close()),
      );
      const identity = yield* Effect.tryPromise({
        try: () => handle.stat(),
        catch: () => "unreadable-file" as const,
      });
      if (!identity.isFile() || identity.dev !== before.dev || identity.ino !== before.ino)
        return failure("unsafe-file");
      if (
        (yield* Effect.tryPromise({
          try: () => realpath(path),
          catch: () => "unsafe-file" as const,
        })) !== path
      )
        return failure("unsafe-file");
      const reader: BoundedReader = {
        size: identity.size,
        read: (buffer) => handle.read(buffer, 0, buffer.length, null).then((value) => value.bytesRead),
      };
      const result = yield* readBounded(reader, remainingBytes);
      chargedBytes = result.bytes;
      const after = yield* Effect.tryPromise({
        try: () => lstat(path),
        catch: () => "unsafe-file" as const,
      });
      const final = yield* Effect.tryPromise({
        try: () => handle.stat(),
        catch: () => "unsafe-file" as const,
      });
      const canonical = yield* Effect.tryPromise({
        try: () => realpath(path),
        catch: () => "unsafe-file" as const,
      });
      const stable =
        after.isFile() &&
        !after.isSymbolicLink() &&
        after.dev === identity.dev &&
        after.ino === identity.ino &&
        canonical === path;
      const parents = yield* checkDirectories(inventory.root).pipe(Effect.result);
      if (!stable || parents._tag === "Failure" || !parents.success)
        return { ...failure("unsafe-file"), bytes: result.bytes };
      if (final.size > limits.fileBytes) return failure("file-limit");
      if (
        final.size !== identity.size ||
        final.mtimeMs !== identity.mtimeMs ||
        final.ctimeMs !== identity.ctimeMs
      )
        return failure("unsafe-file");
      if (result.status !== "read")
        return {
          status: "failed",
          diagnostic: diagnostic(result.status, source),
          bytes: result.bytes,
        };
      return result;
    },
  );
  return yield* attempt.pipe(Effect.catch((code) => Effect.succeed(failure(code))));
}, Effect.scoped);

export class WorkflowAcquisition extends Context.Service<
  WorkflowAcquisition,
  {
    readonly discover: (
      options: ListWorkflowsOptions,
    ) => Effect.Effect<Inventory, GithubActionsWorkflowError>;
    readonly read: (
      inventory: Inventory,
      name: string,
      remainingBytes: number,
    ) => Effect.Effect<AcquiredFile>;
  }
>()("@lando/github-actions/WorkflowAcquisition") {
  static readonly layer = Layer.succeed(this, this.of({ discover, read: readFile }));
}
