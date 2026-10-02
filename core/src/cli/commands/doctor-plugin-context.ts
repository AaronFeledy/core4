import { realpath, stat } from "node:fs/promises";
import { basename, join, posix, win32 } from "node:path";
import { isLando4ExecutableName } from "@lando/engine/install/owned-executable";
import { LandofileServiceLive } from "@lando/engine/services/landofile-live";
import { getLandofileAppRoot } from "@lando/landofile/app-root-provenance";
import { ManagedFileTransactionGuardLive } from "@lando/managed-file/transaction";
import type { DoctorExecutableLocator, DoctorResourceInspector } from "@lando/sdk/plugins";
import {
  type DoctorAppIdentity,
  type DoctorExecutableLocation,
  type DoctorResourceInspection,
  DoctorResourceNameQuery,
} from "@lando/sdk/schema";
import { LandofileService, type RuntimeProviderShape } from "@lando/sdk/services";
import { StateStoreLive } from "@lando/state-store/service";
import { Effect, Layer, Option, Schema } from "effect";
import { loadUserLandofile } from "../app-resolution.ts";
import { describeDoctorCause, redactDoctorMessage } from "./doctor-self.ts";

const DoctorLandofileLive = LandofileServiceLive.pipe(
  Layer.provide(Layer.merge(StateStoreLive, ManagedFileTransactionGuardLive)),
);

export const resolveDoctorAppIdentity = (): Effect.Effect<DoctorAppIdentity | undefined> =>
  Effect.gen(function* () {
    const available = yield* Effect.serviceOption(LandofileService);
    const service = Option.isSome(available)
      ? available.value
      : yield* LandofileService.pipe(Effect.provide(DoctorLandofileLive));
    const landofile = yield* loadUserLandofile(service);
    const root = getLandofileAppRoot(landofile);
    if (root === undefined || landofile.name === undefined) return undefined;
    const canonicalRoot = yield* Effect.tryPromise(() => realpath(root));
    return { name: landofile.name, root: canonicalRoot };
  }).pipe(Effect.catchAllCause(() => Effect.succeed(undefined)));

export const makeDoctorResourceInspector = (options: {
  readonly provider: Effect.Effect<RuntimeProviderShape, unknown>;
  readonly budgetMs: number;
  readonly redact: (message: string) => string;
}): DoctorResourceInspector => {
  const provider = Effect.runSync(Effect.cached(options.provider.pipe(Effect.timeout(options.budgetMs))));
  return {
    inspect: (query) =>
      Effect.gen(function* () {
        const checked = yield* Schema.decodeUnknown(DoctorResourceNameQuery)(query);
        const selected = yield* provider;
        if (selected.inspectResourceNames === undefined)
          return {
            status: "unsupported",
            reason: "Selected provider does not support resource name inspection.",
          } satisfies DoctorResourceInspection;
        const returned = yield* selected.inspectResourceNames(checked);
        const names = [...new Set(returned)].sort().slice(0, checked.limit);
        return {
          status: "ok",
          names,
          truncated: names.length >= checked.limit,
        } satisfies DoctorResourceInspection;
      }).pipe(
        Effect.timeout(options.budgetMs),
        Effect.catchAllCause((cause) => {
          const described = describeDoctorCause(cause);
          const message =
            described.tag === undefined ? described.message : `${described.tag}: ${described.message}`;
          return Effect.succeed({
            status: "unavailable",
            reason: redactDoctorMessage(message, options.redact),
          } satisfies DoctorResourceInspection);
        }),
      ),
  };
};

export const makeDoctorExecutableLocator = (options: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: string;
  readonly execPath: string;
}): DoctorExecutableLocator => {
  const windows = options.platform === "win32";
  const rawBasename = windows ? win32.basename(options.execPath) : basename(options.execPath);
  const runningBasename =
    isLando4ExecutableName(options.execPath, options.platform) ||
    (windows && rawBasename.toLowerCase() === "lando4")
      ? "lando4"
      : rawBasename;
  const envValue = (key: string) =>
    windows
      ? Object.entries(options.env).find(([entry]) => entry.toUpperCase() === key)?.[1]
      : options.env[key];
  return {
    locate: (name) =>
      Effect.gen(function* () {
        const runningPath = yield* Effect.tryPromise(() => realpath(options.execPath)).pipe(
          Effect.catchAll(() => Effect.succeed(undefined)),
        );
        const running = { runningBasename, ...(runningPath === undefined ? {} : { runningPath }) };
        if (name.length === 0 || /[\\/]/u.test(name))
          return {
            ...running,
            candidate: { kind: "ambiguous", reason: "Executable name must be a nonempty basename." },
          } satisfies DoctorExecutableLocation;
        const entries = (envValue("PATH") ?? "").split(windows ? ";" : ":");
        const extensions = windows
          ? (envValue("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
              .split(";")
              .slice(0, 16)
              .filter((ext) => /^\.[a-z0-9]+$/iu.test(ext))
          : [""];
        for (const directory of entries.slice(0, 256)) {
          if (
            directory.length === 0 ||
            !(windows ? win32.isAbsolute(directory) : posix.isAbsolute(directory))
          )
            continue;
          for (const extension of extensions) {
            const candidate = join(directory, `${name}${extension}`);
            const path = yield* Effect.tryPromise(async () => {
              const info = await stat(candidate);
              if (!info.isFile() || (!windows && (info.mode & 0o111) === 0)) return undefined;
              return realpath(candidate);
            }).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
            if (path !== undefined)
              return { ...running, candidate: { kind: "found", path } } satisfies DoctorExecutableLocation;
          }
        }
        return {
          ...running,
          candidate:
            entries.length > 256
              ? { kind: "ambiguous", reason: "PATH exceeds the 256-entry inspection budget." }
              : { kind: "missing" },
        } satisfies DoctorExecutableLocation;
      }).pipe(
        Effect.catchAllCause(() =>
          Effect.succeed({
            runningBasename,
            candidate: { kind: "ambiguous", reason: "Executable location could not be inspected." },
          } satisfies DoctorExecutableLocation),
        ),
      ),
  };
};
