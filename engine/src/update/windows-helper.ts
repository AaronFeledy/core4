import { readFile, rename } from "node:fs/promises";
import { runProbe } from "@lando/sdk/probe";
import { StateStore } from "@lando/sdk/services";
import { StateStoreLive } from "@lando/state-store/service";
import { Duration, Effect, Either, Schema } from "effect";
import { refreshInstallRecord, resolveOwnedExecutable } from "../install/owned-executable.ts";
import { CoreReplacementPreconditionSchema, guardCoreReplacement } from "./compatibility.ts";
import { UpdatePermissionError } from "./errors.ts";
import { makeUpdateHandoff } from "./handoff.ts";

const WindowsReplacementSchema = Schema.Struct({
  executablePath: Schema.String,
  installRecordFile: Schema.String,
  attemptedVersion: Schema.String,
  stagedBinaryPath: Schema.String,
  backupPath: Schema.String,
  token: Schema.String,
  precondition: CoreReplacementPreconditionSchema,
});
const RequestSchema = Schema.extend(
  WindowsReplacementSchema,
  Schema.Struct({
    parentPid: Schema.Int.pipe(Schema.between(1, 2_147_483_647)),
  }),
);

const swapError = () =>
  new UpdatePermissionError({
    message: "Windows core replacement aborted because the binary could not be moved.",
    remediation:
      "Close other Lando processes and re-run lando update; completed plugin updates remain active.",
  });

export const runWindowsReplacement = (
  input: typeof WindowsReplacementSchema.Type,
  handoff: ReturnType<typeof makeUpdateHandoff>,
  move: (from: string, to: string) => Promise<void> = rename,
) =>
  Effect.gen(function* () {
    const outcome = yield* Effect.either(
      guardCoreReplacement(
        input.precondition,
        Effect.gen(function* () {
          const owned = yield* resolveOwnedExecutable({
            recordFile: input.installRecordFile,
            platform: "win32",
            destination: input.executablePath,
          });
          yield* Effect.tryPromise({
            try: () => move(input.executablePath, input.backupPath),
            catch: swapError,
          });
          yield* Effect.gen(function* () {
            yield* Effect.tryPromise({
              try: () => move(input.stagedBinaryPath, input.executablePath),
              catch: swapError,
            });
            const bytes = yield* Effect.tryPromise({
              try: () => Bun.file(input.executablePath).bytes(),
              catch: swapError,
            });
            yield* refreshInstallRecord({
              recordFile: input.installRecordFile,
              record: owned.record,
              sha256: Bun.SHA256.hash(bytes, "hex"),
              size: bytes.byteLength,
              releaseVersion: input.attemptedVersion,
            });
          }).pipe(
            Effect.tapError(() =>
              Effect.tryPromise({
                try: () => move(input.backupPath, input.executablePath),
                catch: swapError,
              }),
            ),
          );
        }),
      ),
    );
    const failure = Either.isLeft(outcome)
      ? {
          tag: outcome.left._tag,
          message: outcome.left.message,
          remediation:
            outcome.left.remediation ?? "Resolve the plugin mutation conflict and re-run lando update.",
        }
      : undefined;
    yield* handoff.finishDeferred(input.token, failure);
    return failure === undefined;
  });

export const runWindowsReplacementProcess = (requestPath: string, token: string) =>
  Effect.gen(function* () {
    yield* Schema.decodeUnknown(Schema.UUID)(token);
    const handoff = makeUpdateHandoff(yield* StateStore);
    return yield* Effect.gen(function* () {
      const request = yield* Effect.tryPromise(() => readFile(requestPath, "utf8")).pipe(
        Effect.flatMap(Schema.decodeUnknown(Schema.parseJson(RequestSchema))),
      );
      if (request.token !== token) return yield* Effect.fail(swapError());
      const parentExited = yield* runProbe(
        {
          id: "update-parent-exit",
          policy: { maxAttempts: 150, delay: Duration.millis(100), timeout: Duration.seconds(15) },
          classify: { success: (dead) => (dead === true ? "green" : "yellow"), failure: () => "red" },
        },
        Effect.sync(() => {
          try {
            process.kill(request.parentPid, 0);
            return false;
          } catch (cause) {
            return cause instanceof Error && "code" in cause && cause.code === "ESRCH";
          }
        }),
      );
      if (parentExited.outcome !== "green") {
        yield* handoff.finishDeferred(request.token, {
          tag: "UpdatePermissionError",
          message: "Windows replacement aborted while waiting for the originating process to exit.",
          remediation:
            "Close other Lando processes and re-run lando update; completed plugin updates remain active.",
        });
        return false;
      }
      return yield* runWindowsReplacement(request, handoff);
    }).pipe(
      Effect.catchAll(() =>
        handoff
          .finishDeferred(token, {
            tag: "UpdatePermissionError",
            message: "Windows replacement aborted because its request could not be processed.",
            remediation:
              "Check the installed core version and re-run lando update; completed plugin updates remain active.",
          })
          .pipe(Effect.as(false)),
      ),
    );
  }).pipe(Effect.provide(StateStoreLive));
