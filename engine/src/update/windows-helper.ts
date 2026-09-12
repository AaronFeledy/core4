import { readFile, rename } from "node:fs/promises";
import { runProbe } from "@lando/sdk/probe";
import { StateStore } from "@lando/sdk/services";
import { StateStoreLive } from "@lando/state-store/service";
import { Duration, Effect, Either, Schema } from "effect";
import { CoreReplacementPreconditionSchema, guardCoreReplacement } from "./compatibility.ts";
import { UpdatePermissionError } from "./errors.ts";
import { makeUpdateHandoff } from "./handoff.ts";

const WindowsReplacementSchema = Schema.Struct({
  executablePath: Schema.String,
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
          yield* Effect.tryPromise({
            try: () => move(input.executablePath, input.backupPath),
            catch: swapError,
          });
          yield* Effect.tryPromise({
            try: () => move(input.stagedBinaryPath, input.executablePath),
            catch: swapError,
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

export const runWindowsReplacementProcess = (requestPath: string) =>
  Effect.gen(function* () {
    const request = yield* Effect.tryPromise(() => readFile(requestPath, "utf8")).pipe(
      Effect.flatMap(Schema.decodeUnknown(Schema.parseJson(RequestSchema))),
    );
    const handoff = makeUpdateHandoff(yield* StateStore);
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
  }).pipe(Effect.provide(StateStoreLive));
