import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { makeAppliedPlanStore, protectedSlotError } from "@lando/container-runtime/applied-state";
import { makeLandoPaths } from "@lando/paths";
import { AbsolutePath } from "@lando/sdk/schema";
import { makePluginStateStore } from "@lando/state-store/plugin";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { makeStateStore } from "@lando/state-store/service";
import { Effect, Result, Schema } from "effect";
import { uninstallCleanupFailure } from "./uninstall-cleanup-error.ts";
import { type RuntimeExec, type UninstallRuntime, runUninstallRuntime } from "./uninstall-runtime.ts";

const missing = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";

const assertPersistedSyncSafe = async (userDataRoot: string): Promise<void> => {
  const paths = makeLandoPaths({ userDataRoot });
  const providerId = "lando";
  const layout = "per-app";
  const stateDir = AbsolutePath.make(paths.pluginStateDir("@lando/provider-lando"));
  const inventory = await Effect.runPromise(
    Effect.gen(function* () {
      const privateFileAccess = yield* PrivateFileAccessService;
      const stateStore = makeStateStore({ privateFileAccess, roots: paths.roots });
      const pluginStore = makePluginStateStore(stateStore, stateDir, privateFileAccess);
      return yield* makeAppliedPlanStore({ providerId, layout }).listAppliedPlans(pluginStore, stateDir);
    }).pipe(Effect.provide(PrivateFileAccessService.layer), Effect.result),
  );
  if (Result.isFailure(inventory))
    throw uninstallCleanupFailure(inventory.failure.message, inventory.failure);
  const issue = inventory.success.unreadable[0];
  if (issue !== undefined) {
    const cause = protectedSlotError(providerId, issue);
    throw uninstallCleanupFailure(
      cause._tag === "AppliedStateVersionError" ? `${cause.message} ${cause.remediation}` : cause.message,
      cause,
    );
  }
  for (const plan of inventory.success.plans) {
    if (
      plan.fileSync.length > 0 ||
      Object.values(plan.services).some((service) =>
        service.mounts?.some((mount) => mount.type === "bind" && mount.realization === "accelerated"),
      )
    )
      throw uninstallCleanupFailure(
        `Cannot safely purge while saved plan ${plan.id} contains accelerated sync state. Run lando stop to flush, then lando destroy --volumes before retrying.`,
      );
  }
  const ledger = join(paths.pluginsDir, "@lando", "file-sync-mutagen", "sessions", "mutagen.json");
  let content: string;
  try {
    content = await readFile(ledger, "utf8");
  } catch (cause) {
    if (missing(cause)) return;
    throw uninstallCleanupFailure(
      "Cannot inspect durable Mutagen session state; preserve the managed runtime.",
      cause,
    );
  }
  const Ledger = Schema.fromJsonString(
    Schema.Struct({
      version: Schema.Literal(1),
      data: Schema.Struct({ sessions: Schema.Array(Schema.Unknown) }),
    }),
  );
  const stamp = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Struct({ version: Schema.Int })))(
    content,
  );
  if (Result.isSuccess(stamp) && stamp.success.version > 1)
    throw uninstallCleanupFailure(
      `Mutagen session state at ${ledger} was written by a newer Lando. Leave the file in place and run a Lando that supports format ${stamp.success.version} before retrying purge.`,
    );
  const decoded = Schema.decodeUnknownResult(Ledger)(content);
  if (Result.isFailure(decoded) || decoded.success.data.sessions.length > 0)
    throw uninstallCleanupFailure(
      "Cannot safely purge while durable Mutagen session state is active or unreadable. Run lando stop to flush, then lando destroy --volumes before retrying.",
    );
};

export const assertUninstallSyncSafe = async (input: {
  readonly userDataRoot: string;
  readonly runtimes: readonly UninstallRuntime[];
  readonly exec: RuntimeExec;
}): Promise<void> => {
  await assertPersistedSyncSafe(input.userDataRoot);
  for (const runtime of input.runtimes) {
    const run = (args: readonly string[]) => runUninstallRuntime(input.exec, runtime, { args });
    try {
      const [containers, volumes] = await Promise.all([
        run(["ps", "-a", "--filter", "label=dev.lando.sync.kind=helper", "--format", "{{.ID}}"]),
        run(["volume", "ls", "--filter", "label=dev.lando.sync.kind=volume", "--format", "{{.Name}}"]),
      ]);
      if (containers.stdout.trim() || volumes.stdout.trim())
        throw uninstallCleanupFailure(
          "accelerated sync helper or volume exists; run lando stop to flush, then lando destroy --volumes before purging",
        );
      if (runtime.managed) {
        const [allContainers, allVolumes] = await Promise.all([
          run(["ps", "-a", "--format", "{{.Names}}"]),
          run(["volume", "ls", "--format", "{{.Name}}"]),
        ]);
        if (
          allContainers.stdout
            .split(/\r?\n/u)
            .some((name) => /^lando-sync-.+-[a-f0-9]{16}$/u.test(name.trim())) ||
          allVolumes.stdout
            .split(/\r?\n/u)
            .some((name) => /-(?:app-mount|mount-(?:[0-9a-f]{8}|[0-9]+))$/u.test(name.trim()))
        )
          throw uninstallCleanupFailure(
            "possible unlabeled Lando sync helper or volume exists; inspect its data before purging",
          );
      }
    } catch (cause) {
      throw uninstallCleanupFailure(
        `Cannot safely purge ${runtime.cmd}: ${cause instanceof Error ? cause.message : String(cause)}. Managed runtime, volumes, and state were preserved.`,
        cause,
      );
    }
  }
};
