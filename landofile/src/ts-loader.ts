/**
 * `.lando.ts` programmatic Landofile loader.
 *
 * Loads a TypeScript Landofile through Bun's TS loader, rejects forbidden
 * imports (host shell-out, network fetch, host filesystem access outside the
 * app root), and bounds module evaluation with a configurable timeout.
 */
import { isBuiltin } from "node:module";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { normalizeHostPlatform } from "@lando/paths";
import {
  LandofileParseError,
  LandofileSandboxError,
  LandofileTimeoutError,
  causeMessage,
} from "@lando/sdk/errors";
import { Clock, Duration, Effect, Predicate } from "effect";
import { importAuthorModule, missingPackageRemediation } from "./author-modules.ts";
import type { EnvironmentRecorder } from "./environment-dependencies.ts";
import { assertUnderRoot } from "./include-guard.ts";
import { hostExpressionEnvironment } from "./recipe-expressions.ts";

export const DEFAULT_TS_TIMEOUT_MS = 5000;
export const TS_TIMEOUT_ENV = "LANDO_LANDOFILE_TS_TIMEOUT_MS";

const SANDBOX_REMEDIATION =
  "Remove the disallowed import or call. Programmatic Landofiles must not perform host shell-outs, remote module fetches, or filesystem access outside the app root.";

const TIMEOUT_REMEDIATION = `Reduce work in the Landofile or raise the timeout via the ${TS_TIMEOUT_ENV} environment variable.`;

const FORBIDDEN_NODE_MODULES: ReadonlySet<string> = new Set([
  "fs",
  "fs/promises",
  "child_process",
  "http",
  "https",
  "http2",
  "net",
  "tls",
  "dgram",
  "cluster",
  "worker_threads",
  "vm",
  "dns",
  "dns/promises",
  "repl",
  "inspector",
]);

// Matches bare `require("x")`, `(require)("x")`, and template-literal forms
// like ``require(`x`)``.
const FORBIDDEN_REQUIRE_REGEX =
  /(?:\brequire\b|\(\s*require\s*\))\s*\(\s*(?:"([^"]*)"|'([^']*)'|`([^`$]*)`)\s*\)/g;

interface ImportLike {
  readonly path: string;
  readonly kind: string;
}

const isUrlProtocol = (path: string): string | undefined => {
  const match = path.match(/^([a-z][a-z0-9+.-]*):/i);
  if (match === null) return undefined;
  const protocol = match[1]?.toLowerCase();
  if (protocol === "node") return undefined;
  return protocol;
};

const stripNodePrefix = (path: string): string =>
  path.startsWith("node:") ? path.slice("node:".length) : path;

const isRelative = (path: string): boolean =>
  path.startsWith("./") || path.startsWith("../") || path === "." || path === "..";

const violationFor = (filePath: string, importPath: string, reason: string): LandofileSandboxError =>
  new LandofileSandboxError({
    message: `Programmatic Landofile at ${filePath} imports "${importPath}": ${reason}.`,
    filePath,
    violation: importPath,
    remediation: SANDBOX_REMEDIATION,
  });

const checkImport = (
  filePath: string,
  appRoot: string,
  importPath: string,
): LandofileSandboxError | undefined => {
  const protocol = isUrlProtocol(importPath);
  if (protocol !== undefined) {
    if (protocol === "bun" || protocol === "data") {
      return violationFor(filePath, importPath, `${protocol}: imports are not allowed`);
    }
    return violationFor(filePath, importPath, `remote module fetch via ${protocol}: is not allowed`);
  }

  const normalized = stripNodePrefix(importPath);
  if (FORBIDDEN_NODE_MODULES.has(normalized)) {
    return violationFor(filePath, importPath, `import of node built-in "${normalized}" is not allowed`);
  }

  if (isRelative(importPath)) {
    const resolved = resolve(dirname(filePath), importPath);
    const rel = relative(appRoot, resolved);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      return violationFor(filePath, importPath, "relative import resolves outside the app root");
    }
  }

  return undefined;
};

const scanImports = (filePath: string, content: string): ReadonlyArray<ImportLike> => {
  const extension = extname(filePath);
  const loader =
    extension === ".tsx"
      ? "tsx"
      : extension === ".jsx"
        ? "jsx"
        : extension === ".js" || extension === ".mjs" || extension === ".cjs"
          ? "js"
          : "ts";
  const transpiler = new Bun.Transpiler({ loader });
  const scanned = transpiler.scan(content);
  return scanned.imports.map((entry) => ({ path: entry.path, kind: entry.kind }));
};

const scanRequireCalls = (content: string): ReadonlyArray<string> => {
  const found: string[] = [];
  FORBIDDEN_REQUIRE_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null = FORBIDDEN_REQUIRE_REGEX.exec(content);
  while (match !== null) {
    const captured = match[1] ?? match[2] ?? match[3];
    if (captured !== undefined) found.push(captured);
    match = FORBIDDEN_REQUIRE_REGEX.exec(content);
  }
  return found;
};

export const sandboxScan = (
  filePath: string,
  appRoot: string,
  content: string,
): Effect.Effect<void, LandofileSandboxError | LandofileParseError> =>
  Effect.suspend((): Effect.Effect<void, LandofileSandboxError | LandofileParseError> => {
    let imports: ReadonlyArray<ImportLike>;
    try {
      imports = scanImports(filePath, content);
    } catch (cause) {
      return Effect.fail(
        new LandofileParseError({
          message: `Failed to parse programmatic Landofile at ${filePath}: ${causeMessage(cause)}`,
          filePath,
          line: undefined,
          column: undefined,
          remediation: `Fix the TypeScript syntax in ${filePath}, then retry.`,
          cause,
        }),
      );
    }

    for (const entry of imports) {
      const failure = checkImport(filePath, appRoot, entry.path);
      if (failure !== undefined) return Effect.fail(failure);
    }

    const requiredCalls = scanRequireCalls(content);
    for (const required of requiredCalls) {
      const failure = checkImport(filePath, appRoot, required);
      if (failure !== undefined) return Effect.fail(failure);
    }

    const firstRequired = requiredCalls[0];
    if (firstRequired !== undefined) {
      return Effect.fail(
        violationFor(filePath, firstRequired, "require() is not supported in programmatic Landofiles"),
      );
    }

    return Effect.void;
  });

export const resolveTimeoutMs = (env: Readonly<Record<string, string | undefined>> = process.env): number => {
  const raw = env[TS_TIMEOUT_ENV];
  if (raw === undefined || raw === "") return DEFAULT_TS_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TS_TIMEOUT_MS;
  return parsed;
};

export interface LandofileContext {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly host: {
    readonly os: NodeJS.Platform;
    readonly arch: string;
    readonly platform: NodeJS.Platform;
    readonly isWsl: boolean;
  };
}

const buildContext = (
  filePath: string,
  env: Readonly<Record<string, string | undefined>>,
): LandofileContext => {
  const platform = process.platform;
  const isWsl = normalizeHostPlatform() === "wsl";
  return {
    cwd: dirname(filePath),
    // Read-only captured snapshot; prefer ctx.env over process.env so reads are tracked.
    env,
    host: { os: platform, arch: process.arch, platform, isWsl },
  };
};

const isModuleObject: (value: unknown) => value is object = Predicate.isObjectOrArray;

const unwrapDefault = async (
  filePath: string,
  module: unknown,
  env: Readonly<Record<string, string | undefined>>,
): Promise<unknown> => {
  if (!isModuleObject(module)) {
    throw new LandofileParseError({
      message: `Programmatic Landofile at ${filePath} did not export a module object.`,
      filePath,
      line: undefined,
      column: undefined,
      remediation: `Export a module object from ${filePath} with a default Landofile value or factory.`,
    });
  }
  const exported = Predicate.hasProperty(module, "default") ? module.default : undefined;
  if (exported === undefined) {
    throw new LandofileParseError({
      message: `Programmatic Landofile at ${filePath} is missing a default export.`,
      filePath,
      line: undefined,
      column: undefined,
      remediation: `Add a default export of a Landofile value or (ctx) => Landofile factory in ${filePath}.`,
    });
  }
  if (typeof exported === "function") {
    const ctx = buildContext(filePath, env);
    const result = (exported as (ctx: LandofileContext) => unknown)(ctx);
    return await resolveTsModuleResult(result);
  }
  return await resolveTsModuleResult(exported);
};

export const resolveTsModuleResult = async (result: unknown): Promise<unknown> => {
  if (!isModuleObject(result)) return result;
  if (Effect.isEffect(result)) {
    return await Effect.runPromise(result as Effect.Effect<unknown, unknown>);
  }
  if (typeof Reflect.get(result, "then") === "function") {
    return await resolveTsModuleResult(await Promise.resolve(result));
  }
  return result;
};

const evaluateImport = Effect.fnUntraced(function* (
  filePath: string,
  env: Readonly<Record<string, string | undefined>>,
) {
  const importTime = yield* Clock.currentTimeMillis;
  return yield* Effect.tryPromise({
    try: async () => {
      const module = await importAuthorModule(`${filePath}?t=${importTime}`);
      return await unwrapDefault(filePath, module, env);
    },
    catch: (cause) =>
      cause instanceof LandofileParseError
        ? cause
        : new LandofileParseError({
            message: `Failed to load programmatic Landofile at ${filePath}: ${causeMessage(cause)}`,
            filePath,
            line: undefined,
            column: undefined,
            remediation:
              missingPackageRemediation(causeMessage(cause)) ??
              `Fix the TypeScript, imports, and default export in ${filePath} so the module evaluates successfully.`,
            cause,
          }),
  });
});

export interface LoadLandofileTsOptions {
  readonly filePath: string;
  readonly appRoot: string;
  readonly content: string;
  readonly timeoutMs?: number;
  readonly contained?: boolean;
  /**
   * Captured host environment. When `environmentRecorder` is set, `ctx.env` is
   * its read-only view so factory reads are tracked; otherwise a frozen copy of
   * this snapshot (default: captured via `hostExpressionEnvironment()`).
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly environmentRecorder?: EnvironmentRecorder;
}

// Any of these can reach the environment without going through ctx.env. The import scan does not
// report CommonJS loads, so `require` counts too.
const AMBIENT_ENVIRONMENT_REFERENCE =
  /\bprocess\b|\bBun\b|\bimport\s*\.\s*meta\b|\bglobalThis\b|\bimport\s*\(|\brequire\b/u;
// Modules Lando supplies to author code; they do not read the environment while a Landofile loads.
const HOST_SUPPLIED_MODULE = /^(?:@lando\/sdk|effect)(?:\/|$)/u;
const LOCAL_MODULE_SUFFIXES = ["", ".ts", ".tsx", ".mts", ".js", ".mjs", "/index.ts", "/index.js"] as const;

const localModuleSource = async (
  specifier: string,
): Promise<{ path: string; content: string } | undefined> => {
  for (const suffix of LOCAL_MODULE_SUFFIXES) {
    const file = Bun.file(specifier + suffix);
    if (await file.exists()) return { path: specifier + suffix, content: await file.text() };
  }
  return undefined;
};

/**
 * Whether the Landofile or a local module it imports can read the environment outside ctx.env.
 * Package imports other than the host-supplied modules count as reading it: Lando cannot inspect them.
 */
const readsAmbientEnvironment = async (
  filePath: string,
  content: string,
  seen: Set<string> = new Set(),
): Promise<boolean> => {
  if (seen.has(filePath)) return false;
  seen.add(filePath);
  if (AMBIENT_ENVIRONMENT_REFERENCE.test(content)) return true;
  for (const entry of scanImports(filePath, content)) {
    if (HOST_SUPPLIED_MODULE.test(entry.path)) continue;
    if (!isRelative(entry.path)) return true;
    const local = await localModuleSource(resolve(dirname(filePath), entry.path));
    if (local === undefined || (await readsAmbientEnvironment(local.path, local.content, seen))) return true;
  }
  return false;
};

const assertContainedImports = async (
  input: Pick<LoadLandofileTsOptions, "filePath" | "appRoot" | "content">,
): Promise<void> => {
  const { hostModules } = await import("./host-module-table.ts");
  const seen = new Set([input.filePath]);
  const visit = async (filePath: string, content: string): Promise<void> => {
    for (const { path } of scanImports(filePath, content)) {
      if (Object.hasOwn(hostModules, path)) continue;
      const resolved = Bun.resolveSync(path, dirname(filePath));
      if (isBuiltin(resolved)) continue;
      const physical = await assertUnderRoot(input.appRoot, resolved, path);
      if (seen.has(physical)) continue;
      seen.add(physical);
      if (/\.(?:[cm]?[jt]s|[jt]sx)$/u.test(physical)) await visit(physical, await Bun.file(physical).text());
    }
  };
  await visit(input.filePath, input.content);
};

export const loadLandofileTs = Effect.fnUntraced(function* (
  options: LoadLandofileTsOptions,
): Effect.fn.Return<unknown, LandofileSandboxError | LandofileTimeoutError | LandofileParseError> {
  const physical = options.contained
    ? yield* Effect.tryPromise({
        try: () => assertUnderRoot(options.appRoot, options.filePath, options.filePath),
        catch: (cause) => violationFor(options.filePath, options.filePath, causeMessage(cause)),
      })
    : options.filePath;
  yield* sandboxScan(physical, options.appRoot, options.content);
  if (options.contained)
    yield* Effect.tryPromise({
      // Bun resolves dependencies of a symlinked module relative to its physical target.
      try: () => assertContainedImports({ ...options, filePath: physical }),
      catch: (cause) =>
        new LandofileSandboxError({
          message: `Cannot load a copied Landofile module at ${options.filePath}: ${causeMessage(cause)}`,
          filePath: options.filePath,
          violation: causeMessage(cause),
          remediation: "Keep Landofile module files and project imports inside the copied app.",
        }),
    });
  // Reads that bypass ctx.env cannot be recorded, so the load depends on the whole environment.
  // A module graph Lando cannot analyze counts as reading the environment.
  if (
    options.environmentRecorder !== undefined &&
    (yield* Effect.tryPromise(() => readsAmbientEnvironment(physical, options.content)).pipe(
      Effect.orElseSucceed(() => true),
    ))
  )
    options.environmentRecorder.recordComplete();
  const timeoutMs = options.timeoutMs ?? resolveTimeoutMs(options.env);
  const env =
    options.environmentRecorder?.view ??
    Object.freeze({
      ...(options.env !== undefined ? hostExpressionEnvironment(options.env) : hostExpressionEnvironment()),
    });
  return yield* Effect.timeoutOrElse(evaluateImport(options.filePath, env), {
    duration: Duration.millis(timeoutMs),
    orElse: () =>
      Effect.fail(
        (() =>
          new LandofileTimeoutError({
            message: `Programmatic Landofile at ${options.filePath} did not produce a value within ${timeoutMs}ms.`,
            filePath: options.filePath,
            timeoutMs,
            remediation: TIMEOUT_REMEDIATION,
          }))(),
      ),
  });
});
