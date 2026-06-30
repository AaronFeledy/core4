import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import ts from "typescript";

export interface NetworkBoundaryOffender {
  readonly file: string;
  readonly line: number;
  readonly match: string;
}

export interface NetworkBoundaryResult {
  readonly ok: boolean;
  readonly offenders: ReadonlyArray<NetworkBoundaryOffender>;
}

interface CheckNetworkBoundaryOptions {
  readonly root?: string;
}

const repoRoot = resolve(import.meta.dirname, "..");

const SCANNED_ROOTS = ["core/src", "plugins"] as const;

// Prefer EMPTY: migrate offenders onto the HttpClient adapter, do not carve out.
const CARVE_OUTS = new Set<string>([]);

// The one place a direct global fetch is allowed: the HttpClient adapter itself,
// which is the canonical egress boundary every other call site routes through.
const ADAPTER_PATHS = new Set<string>(["core/src/http-client/live.ts"]);

// Global objects whose `.fetch(...)` is a direct global-fetch call.
const GLOBAL_OBJECTS = new Set<string>(["globalThis", "Bun", "self", "window"]);

const collectTsFiles = async (dir: string): Promise<ReadonlyArray<string>> => {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await collectTsFiles(full)));
        continue;
      }
      if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(full);
    }

    return files;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
};

/**
 * Identify a direct global-fetch call expression. Returns the display match
 * (e.g. `fetch`, `globalThis.fetch`, `Bun.fetch`, `globalThis['fetch']`) or
 * `undefined` when the call is not a direct global fetch.
 *
 * Detected:
 *  - `fetch(...)` (bare identifier callee)
 *  - `globalThis.fetch(...)`, `Bun.fetch(...)`, `self.fetch(...)`, `window.fetch(...)`
 *  - `globalThis["fetch"](...)` element access on a global object
 *
 * NOT detected (intentionally):
 *  - `obj.fetch(...)` / `ctx.fetch(...)` method calls on arbitrary objects
 *  - `fetchImpl(...)` and other aliases
 *  - bare references like `?? globalThis.fetch` (no call)
 */
const matchGlobalFetchCall = (call: ts.CallExpression): string | undefined => {
  const callee = call.expression;

  if (ts.isIdentifier(callee) && callee.text === "fetch") return "fetch";

  if (ts.isPropertyAccessExpression(callee) && callee.name.text === "fetch") {
    const target = callee.expression;
    if (ts.isIdentifier(target) && GLOBAL_OBJECTS.has(target.text)) {
      return `${target.text}.fetch`;
    }
    return undefined;
  }

  if (ts.isElementAccessExpression(callee)) {
    const target = callee.expression;
    const argument = callee.argumentExpression;
    if (
      ts.isIdentifier(target) &&
      GLOBAL_OBJECTS.has(target.text) &&
      ts.isStringLiteralLike(argument) &&
      argument.text === "fetch"
    ) {
      return `${target.text}['fetch']`;
    }
  }

  return undefined;
};

const scanFile = async (file: string): Promise<ReadonlyArray<NetworkBoundaryOffender>> => {
  const sourceText = await Bun.file(file).text();
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const offenders: NetworkBoundaryOffender[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const match = matchGlobalFetchCall(node);
      if (match !== undefined) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        offenders.push({ file, line: line + 1, match });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return offenders;
};

export const checkNetworkBoundary = async (
  options: CheckNetworkBoundaryOptions = {},
): Promise<NetworkBoundaryResult> => {
  const root = resolve(options.root ?? repoRoot);
  const files = (
    await Promise.all(SCANNED_ROOTS.map((scannedRoot) => collectTsFiles(resolve(root, scannedRoot))))
  )
    .flat()
    .sort();

  const offenders = (
    await Promise.all(
      files.map(async (file) => {
        const relativeFile = relative(root, file).replaceAll("\\", "/");
        if (CARVE_OUTS.has(relativeFile) || ADAPTER_PATHS.has(relativeFile)) return [];
        const found = await scanFile(file);
        return found.map((offender) => ({ ...offender, file: relativeFile }));
      }),
    )
  )
    .flat()
    .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);

  return { ok: offenders.length === 0, offenders };
};

const formatOffender = (offender: NetworkBoundaryOffender): string =>
  `${offender.file}:${offender.line}: ${offender.match}`;

if (import.meta.main) {
  const result = await checkNetworkBoundary({ root: repoRoot });
  if (result.ok) {
    process.stdout.write("Network boundary check passed.\n");
  } else {
    process.stderr.write(
      `Network boundary check failed. Lando-owned outbound HTTP must route through the HttpClient adapter (@lando/core HttpClient), not direct global fetch. Carve-outs are limited to BunSelfRunner package-manager ops and the standalone installer scripts.\n${result.offenders
        .map(formatOffender)
        .join("\n")}\n`,
    );
    process.exitCode = 1;
  }
}
