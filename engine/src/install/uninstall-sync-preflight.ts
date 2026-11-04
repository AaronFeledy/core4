import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { AppPlan } from "@lando/sdk/schema";
import { Result, Schema } from "effect";
import { uninstallCleanupFailure } from "./uninstall-cleanup-error.ts";
import { type RuntimeExec, type UninstallRuntime, runUninstallRuntime } from "./uninstall-runtime.ts";

const missing = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";

const assertPersistedSyncSafe = async (userDataRoot: string): Promise<void> => {
  const paths = makeLandoPaths({ userDataRoot });
  const plans = join(paths.pluginsDir, "@lando", "provider-lando", "applied-plans");
  let entries: readonly string[];
  try {
    entries = await readdir(plans);
  } catch (cause) {
    if (!missing(cause))
      throw uninstallCleanupFailure(
        "Cannot inspect saved Lando plans before purge; preserve the managed runtime and retry.",
        cause,
      );
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const envelope: unknown = JSON.parse(await readFile(join(plans, entry), "utf8"));
      if (
        typeof envelope !== "object" ||
        envelope === null ||
        Array.isArray(envelope) ||
        (Reflect.get(envelope, "version") !== 1 && Reflect.get(envelope, "version") !== 2)
      )
        throw uninstallCleanupFailure("invalid envelope");
      const plan: unknown = Reflect.get(envelope, "data");
      if (typeof plan !== "object" || plan === null || Array.isArray(plan))
        throw uninstallCleanupFailure("invalid plan");
      const sync = Reflect.get(plan, "fileSync");
      const services = Reflect.get(plan, "services");
      const reserved = Reflect.get(plan, "id") === "global" && sync === undefined;
      if (typeof services !== "object" || services === null || Array.isArray(services))
        throw uninstallCleanupFailure("invalid services");
      if (
        !reserved &&
        (Result.isFailure(Schema.decodeUnknownResult(AppPlan)(plan)) ||
          !Array.isArray(sync) ||
          sync.length > 0)
      )
        throw uninstallCleanupFailure("invalid or accelerated plan");
      for (const service of Object.values(services)) {
        if (typeof service !== "object" || service === null || Array.isArray(service))
          throw uninstallCleanupFailure("invalid service");
        const mounts: unknown = Reflect.get(service, "mounts");
        // Legacy v1 frames may still carry appMount; reject accelerated there too.
        const appMount: unknown = Reflect.get(service, "appMount");
        if (
          reserved &&
          ((Array.isArray(mounts) && mounts.length > 0) ||
            (appMount !== undefined && appMount !== null) ||
            (mounts !== undefined && !Array.isArray(mounts)))
        )
          throw uninstallCleanupFailure("invalid global plan");
        if (
          typeof appMount === "object" &&
          appMount !== null &&
          Reflect.get(appMount, "realization") === "accelerated"
        )
          throw uninstallCleanupFailure("accelerated app mount");
        if (
          Array.isArray(mounts) &&
          mounts.some(
            (mount) =>
              typeof mount === "object" &&
              mount !== null &&
              Reflect.get(mount, "realization") === "accelerated",
          )
        )
          throw uninstallCleanupFailure("accelerated mount");
      }
    } catch (cause) {
      throw uninstallCleanupFailure(
        `Cannot safely purge while saved plan ${entry} contains accelerated or unreadable sync state. Run lando stop to flush, then lando destroy --volumes before retrying.`,
        cause,
      );
    }
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
