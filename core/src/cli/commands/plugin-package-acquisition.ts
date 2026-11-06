import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { validatePluginManifest } from "@lando/engine/operations/plugin-install";
import {
  NotImplementedError,
  PluginManifestError,
  PluginPackageOperationError,
  isErrnoCode,
} from "@lando/sdk/errors";
import type { SourceAcquisitionError, SourceSession } from "@lando/source-acquisition";
import { parseNpmPackageSpec } from "@lando/source-acquisition/npm";
import { Effect, Scope } from "effect";
import type { PluginAddOptions } from "./plugin-add-options";

export const ensurePluginsRoot = async (root: string): Promise<void> => {
  await mkdir(root, { recursive: true });
  const path = join(root, "package.json");
  if (!existsSync(path))
    await writeFile(
      path,
      `${JSON.stringify({ name: "lando-plugin-root", private: true, version: "0.0.0", description: "Managed by Lando." }, null, 2)}\n`,
    );
};
export const packageDeclaresPostinstall = async (packageDir: string): Promise<boolean> => {
  const packageJson: unknown = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
  if (typeof packageJson !== "object" || packageJson === null || !("scripts" in packageJson)) return false;
  const scripts: unknown = packageJson.scripts;
  if (typeof scripts !== "object" || scripts === null || !("postinstall" in scripts)) return false;
  return typeof scripts.postinstall === "string" && scripts.postinstall.trim() !== "";
};
const sourceOperation = (
  kind: SourceAcquisitionError["kind"],
  phase: "resolve" | "materialize",
): PluginPackageOperationError["operation"] => {
  switch (kind) {
    case "integrity-mismatch":
    case "integrity-missing":
      return "verify";
    case "extract-failed":
      return "extract";
    case "invalid-locator":
    case "not-found":
    case "version-not-found":
      return "resolve";
    case "checksum-mismatch":
    case "offline-miss":
    case "cache":
    case "auth":
    case "fetch-failed":
      return phase === "resolve" ? "resolve" : "download";
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
};
export const acquirePluginPackage = Effect.fn("PluginAdd.acquirePackage")(function* (input: {
  readonly options: PluginAddOptions;
  readonly pluginsRoot: string;
  readonly session: SourceSession;
  readonly installScope: Scope.Scope;
}) {
  const { options, pluginsRoot, session, installScope } = input;
  const failure = (
    operation: PluginPackageOperationError["operation"],
    cause: unknown,
    remediation = "Correct the reported package acquisition failure and retry plugin installation.",
  ) =>
    new PluginPackageOperationError({
      message: `Plugin package ${operation} failed for ${options.spec}.`,
      commandId: "meta:plugin:add",
      operation,
      packageSpec: options.spec,
      cwd: pluginsRoot,
      detail: cause instanceof Error ? cause.message : String(cause),
      remediation,
    });
  const mapSource = (phase: "resolve" | "materialize") => (error: SourceAcquisitionError) =>
    failure(sourceOperation(error.kind, phase), error, error.remediation);
  const parsed = yield* Effect.try({
    try: () => parseNpmPackageSpec(options.spec),
    catch: (cause) => failure("resolve", cause),
  });
  const pin = yield* session
    .resolveNpm({ name: parsed.name, ...(parsed.version === undefined ? {} : { selector: parsed.version }) })
    .pipe(Effect.mapError(mapSource("resolve")));
  const packageDir = yield* Effect.try({
    try: () => {
      for (const [label, value] of [
        ["name", pin.name],
        ["version", pin.version],
      ]) {
        if (
          value === undefined ||
          value.trim() === "" ||
          isAbsolute(value) ||
          value.includes("\\") ||
          value.split("/").some((part) => part === "" || part === "." || part === "..")
        ) {
          throw new NotImplementedError({
            message: `Resolved npm plugin ${label} escapes the plugin root: ${value}`,
            commandId: "meta:plugin:add",
            remediation: `Check the npm package spec and registry metadata, then retry \`lando plugin:add ${options.spec}\`.`,
          });
        }
      }
      const path = join(pluginsRoot, pin.name, pin.version);
      const rel = relative(pluginsRoot, path);
      if (rel === "" || rel === ".." || rel.startsWith("../") || isAbsolute(rel))
        throw failure("resolve", "Resolved plugin path escapes the install root.");
      return path;
    },
    catch: (cause) =>
      cause instanceof NotImplementedError || cause instanceof PluginPackageOperationError
        ? cause
        : failure("resolve", cause),
  });
  const exists = yield* Effect.tryPromise({
    try: () =>
      stat(packageDir)
        .then(() => true)
        .catch((cause: unknown) => {
          if (isErrnoCode(cause, "ENOENT")) return false;
          throw cause;
        }),
    catch: (cause) => failure("resolve", cause),
  });
  if (options.expectedActivation === undefined && exists)
    return { created: false, packageDir, stagingRoot: undefined, targetDir: undefined };
  const snapshot = yield* session.materializeNpm(pin).pipe(Effect.mapError(mapSource("materialize")));
  const stagingRoot = yield* Effect.tryPromise({
    try: async () => {
      const parent = dirname(packageDir);
      await mkdir(parent, { recursive: true });
      return mkdtemp(join(parent, ".staging-"));
    },
    catch: (cause) => failure("extract", cause),
  });
  yield* Scope.addFinalizer(
    installScope,
    Effect.promise(() => rm(stagingRoot, { recursive: true, force: true })),
  );
  const extractedPackageDir = join(stagingRoot, "package");
  yield* Effect.tryPromise({
    try: () =>
      cp(join(snapshot.root, "package"), extractedPackageDir, { recursive: true, errorOnExist: true }),
    catch: (cause) => failure("extract", cause),
  });
  yield* Effect.tryPromise({
    try: () => validatePluginManifest(extractedPackageDir),
    catch: (cause) => (cause instanceof PluginManifestError ? cause : failure("extract", cause)),
  });
  return { created: true, packageDir: extractedPackageDir, targetDir: packageDir, stagingRoot };
});
