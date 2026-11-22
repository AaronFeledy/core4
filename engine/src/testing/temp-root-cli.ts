import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { CommandResultEnvelope } from "@lando/sdk/schema";
import type { ProcessResult, ProcessSpawnOptions } from "@lando/sdk/services";
import { Effect, Schema, Stream } from "effect";
import { isCanonicalScratchId } from "../scratch-app/scanner.ts";
import { service as processRunner } from "../services/process-runner.ts";
import { retirementError, retirementFailures } from "./temp-root-failure.ts";

const Envelope = Schema.fromJsonString(
  Schema.Union([CommandResultEnvelope, Schema.TaggedStruct("result", { envelope: CommandResultEnvelope })]),
);
const Apps = Schema.Struct({
  apps: Schema.Array(
    Schema.Struct({
      appRoot: Schema.String,
      providerId: Schema.String,
      scratch: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
const ScratchApps = Schema.Array(Schema.Struct({ id: Schema.NonEmptyString }));

const runProcess = Effect.fnUntraced(function* (input: ProcessSpawnOptions) {
  const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  const result = yield* processRunner.streamWithExit(input).pipe(
    Stream.runFold(
      () => ({ exitCode: 1, stdout: "", stderr: "" }),
      (result, event) =>
        "exitCode" in event
          ? { ...result, exitCode: event.exitCode }
          : {
              ...result,
              [event.kind]: result[event.kind] + decoders[event.kind].decode(event.chunk, { stream: true }),
            },
    ),
  );
  return {
    ...result,
    stdout: result.stdout + decoders.stdout.decode(),
    stderr: result.stderr + decoders.stderr.decode(),
  };
});

export const retireCliResources = Effect.fnUntraced(function* (input: {
  readonly command: readonly [string, ...string[]];
  readonly directory: string;
  readonly env: Readonly<Record<string, string>>;
  readonly providerId: string;
  readonly ownedAppRoots: Effect.Effect<
    ReadonlySet<string>,
    import("./temp-root-failure.ts").TempRootRetirementError
  >;
  readonly runCli?: (input: ProcessSpawnOptions) => Promise<ProcessResult>;
}) {
  const [cmd, ...prefix] = input.command;
  const signal = AbortSignal.timeout(120_000);
  const failed: import("./temp-root-failure.ts").TempRootRetirementError[] = [];
  const invoke = Effect.fnUntraced(function* (
    target: string,
    flags: readonly string[],
    cwd = input.directory,
  ) {
    const options = {
      cmd,
      args: [...prefix, target, "--format=json", ...flags],
      cwd,
      env: input.env,
      replaceEnv: true,
      capture: true,
      timeoutMs: 30_000,
      signal,
    };
    const runner = input.runCli;
    const result = yield* runner === undefined
      ? runProcess(options).pipe(retirementFailures(target))
      : Effect.tryPromise({ try: () => runner(options), catch: (cause) => retirementError(target, cause) });
    if (result.exitCode !== 0)
      return yield* retirementError(
        target,
        `Exit ${result.exitCode}: ${(result.stdout.trim() || result.stderr.trim()).slice(-4096)}`,
      );
    return result.stdout;
  });
  const attempt = <A>(effect: Effect.Effect<A, import("./temp-root-failure.ts").TempRootRetirementError>) =>
    effect.pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          failed.push(error);
          return undefined;
        }),
      ),
    );
  const list = (target: string, flags: readonly string[]) =>
    invoke(target, flags).pipe(
      Effect.flatMap((stdout) => Schema.decodeUnknownEffect(Envelope)(stdout.trim().split("\n").at(-1))),
      retirementFailures(target),
      Effect.flatMap((decoded) => {
        const envelope = "envelope" in decoded ? decoded.envelope : decoded;
        return envelope.ok
          ? Effect.succeed(envelope.result)
          : Effect.fail(retirementError(target, envelope.error?.message ?? "CLI inventory failed."));
      }),
    );
  const apps = yield* attempt(
    list("apps:list", ["--all"]).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Apps)),
      retirementFailures("apps:list"),
    ),
  );
  const candidates = new Set(
    apps?.apps
      .filter((app) => !app.scratch && app.providerId === input.providerId && isAbsolute(app.appRoot))
      .map((app) => app.appRoot),
  );
  if (candidates.size > 0) {
    const owned = yield* attempt(input.ownedAppRoots);
    for (const root of candidates) {
      if (!owned?.has(root)) continue;
      const exists = yield* attempt(
        Effect.tryPromise({
          try: () =>
            stat(root).then(
              (info) => info.isDirectory(),
              (error: unknown) => {
                if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
                throw error;
              },
            ),
          catch: (cause) => retirementError(root, cause),
        }),
      );
      if (exists)
        yield* attempt(
          invoke("app:destroy", ["--provider", input.providerId, "--purge", "--purge-caches", "--yes"], root),
        );
    }
  }
  const scratch = yield* attempt(
    list("apps:scratch:list", []).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ScratchApps)),
      retirementFailures("apps:scratch:list"),
    ),
  );
  for (const { id } of scratch ?? []) {
    if (isCanonicalScratchId(id)) yield* attempt(invoke("apps:scratch:destroy", [id, "--yes"]));
    else failed.push(retirementError(id, "Scratch inventory returned a noncanonical ID."));
  }
  yield* attempt(
    invoke("apps:gc", ["--provider", input.providerId, "--prune", "--purge", "--purge-caches", "--yes"]),
  );
  yield* attempt(invoke("meta:global:destroy", ["--provider", input.providerId, "--purge", "--yes"]));
  return failed;
});
