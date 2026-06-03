import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import ts from "typescript";

export interface RendererBoundaryOffender {
  readonly file: string;
  readonly line: number;
  readonly match: string;
}

export interface RendererBoundaryResult {
  readonly ok: boolean;
  readonly offenders: ReadonlyArray<RendererBoundaryOffender>;
}

interface CheckRendererBoundaryOptions {
  readonly root?: string;
}

const repoRoot = resolve(import.meta.dirname, "..");

const SCANNED_ROOTS = ["core/src", "plugins"] as const;
const CARVE_OUTS = new Set(["core/bin/lando.ts", "core/src/cli/oclif/pre-renderer.ts"]);

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

const propertyName = (node: ts.PropertyName): string | undefined => {
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  return undefined;
};

const directWriteMatch = (node: ts.CallExpression): string | undefined => {
  const expression = node.expression;
  if (!ts.isPropertyAccessExpression(expression)) return undefined;

  const method = propertyName(expression.name);
  const target = expression.expression;

  if (ts.isIdentifier(target) && target.text === "console") {
    return method === undefined ? "console.<computed>" : `console.${method}`;
  }

  if (method !== "write" || !ts.isPropertyAccessExpression(target)) return undefined;
  const stream = propertyName(target.name);
  const processExpression = target.expression;
  if (ts.isIdentifier(processExpression) && processExpression.text === "process") {
    if (stream === "stdout" || stream === "stderr") return `process.${stream}.write`;
  }

  return undefined;
};

const scanFile = async (file: string): Promise<ReadonlyArray<RendererBoundaryOffender>> => {
  const sourceText = await Bun.file(file).text();
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const offenders: RendererBoundaryOffender[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const match = directWriteMatch(node);
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

export const checkRendererBoundary = async (
  options: CheckRendererBoundaryOptions = {},
): Promise<RendererBoundaryResult> => {
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
        if (CARVE_OUTS.has(relativeFile)) return [];
        return scanFile(file);
      }),
    )
  )
    .flat()
    .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);

  return { ok: offenders.length === 0, offenders };
};

const formatOffender = (root: string, offender: RendererBoundaryOffender): string =>
  `${relative(root, offender.file).replaceAll("\\", "/")}:${offender.line}: ${offender.match}`;

if (import.meta.main) {
  const result = await checkRendererBoundary({ root: repoRoot });
  if (result.ok) {
    process.stdout.write("Renderer boundary check passed.\n");
  } else {
    process.stderr.write(
      `Renderer boundary check failed. Direct console/process writes must route through the Renderer boundary.\n${result.offenders
        .map((offender) => formatOffender(repoRoot, offender))
        .join("\n")}\n`,
    );
    process.exitCode = 1;
  }
}
