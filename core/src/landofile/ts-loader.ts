/**
 * `.lando.ts` programmatic Landofile loader.
 *
 * Loads a TypeScript Landofile through Bun's TS loader, rejects forbidden
 * imports (host shell-out, network fetch, host filesystem access outside the
 * app root), and bounds module evaluation with a configurable timeout.
 */
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { Duration, Effect } from "effect";

import { LandofileParseError, LandofileSandboxError, LandofileTimeoutError } from "@lando/sdk/errors";

export const DEFAULT_TS_TIMEOUT_MS = 5000;
export const TS_TIMEOUT_ENV = "LANDO_LANDOFILE_TS_TIMEOUT_MS";

const SANDBOX_REMEDIATION =
  "Remove the disallowed import or call. Programmatic Landofiles must not perform host shell-outs, remote module fetches, or filesystem access outside the app root. See spec/07-landofile-and-config.md §7.1.1.";

const TIMEOUT_REMEDIATION = `Reduce work in the Landofile or raise the timeout via the ${TS_TIMEOUT_ENV} environment variable. See spec/07-landofile-and-config.md §7.1.1.`;

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
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      return violationFor(filePath, importPath, "relative import resolves outside the app root");
    }
  }

  return undefined;
};

const scanImports = (content: string): ReadonlyArray<ImportLike> => {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
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
): Effect.Effect<void, LandofileSandboxError> =>
  Effect.suspend(() => {
    let imports: ReadonlyArray<ImportLike>;
    try {
      imports = scanImports(content);
    } catch (cause) {
      return Effect.fail(
        new LandofileSandboxError({
          message: `Failed to parse programmatic Landofile at ${filePath}: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
          filePath,
          violation: "parse",
          remediation: SANDBOX_REMEDIATION,
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

export const resolveTimeoutMs = (): number => {
  const raw = process.env[TS_TIMEOUT_ENV];
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

const buildContext = (filePath: string): LandofileContext => {
  const platform = process.platform;
  const isWsl = platform === "linux" && (process.env.WSL_DISTRO_NAME ?? "") !== "";
  return {
    cwd: dirname(filePath),
    env: process.env,
    host: { os: platform, arch: process.arch, platform, isWsl },
  };
};

const unwrapDefault = async (filePath: string, module: unknown): Promise<unknown> => {
  if (module === null || typeof module !== "object") {
    throw new LandofileParseError({
      message: `Programmatic Landofile at ${filePath} did not export a module object.`,
      filePath,
      line: undefined,
      column: undefined,
    });
  }
  const exported = (module as { default?: unknown }).default;
  if (exported === undefined) {
    throw new LandofileParseError({
      message: `Programmatic Landofile at ${filePath} is missing a default export.`,
      filePath,
      line: undefined,
      column: undefined,
    });
  }
  if (typeof exported === "function") {
    const ctx = buildContext(filePath);
    const result = (exported as (ctx: LandofileContext) => unknown)(ctx);
    return await resolveLandofileResult(result);
  }
  return await resolveLandofileResult(exported);
};

const resolveLandofileResult = async (result: unknown): Promise<unknown> => {
  if (result === null || typeof result !== "object") return result;
  if (Effect.isEffect(result)) {
    return await Effect.runPromise(result as Effect.Effect<unknown, unknown>);
  }
  if (typeof (result as { then?: unknown }).then === "function") {
    return await resolveLandofileResult(await (result as Promise<unknown>));
  }
  return result;
};

const evaluateImport = (filePath: string): Effect.Effect<unknown, LandofileParseError> =>
  Effect.tryPromise({
    try: async () => {
      const module = await import(`${filePath}?t=${Date.now()}`);
      return await unwrapDefault(filePath, module);
    },
    catch: (cause) =>
      cause instanceof LandofileParseError
        ? cause
        : new LandofileParseError({
            message: `Failed to load programmatic Landofile at ${filePath}: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
            filePath,
            line: undefined,
            column: undefined,
            cause,
          }),
  });

export interface LoadLandofileTsOptions {
  readonly filePath: string;
  readonly appRoot: string;
  readonly content: string;
  readonly timeoutMs?: number;
}

export const loadLandofileTs = (
  options: LoadLandofileTsOptions,
): Effect.Effect<unknown, LandofileSandboxError | LandofileTimeoutError | LandofileParseError> =>
  Effect.gen(function* () {
    yield* sandboxScan(options.filePath, options.appRoot, options.content);
    const timeoutMs = options.timeoutMs ?? resolveTimeoutMs();
    return yield* Effect.timeoutFail(evaluateImport(options.filePath), {
      duration: Duration.millis(timeoutMs),
      onTimeout: () =>
        new LandofileTimeoutError({
          message: `Programmatic Landofile at ${options.filePath} did not produce a value within ${timeoutMs}ms.`,
          filePath: options.filePath,
          timeoutMs,
          remediation: TIMEOUT_REMEDIATION,
        }),
    });
  });
