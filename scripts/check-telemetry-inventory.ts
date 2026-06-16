import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import ts from "typescript";

import { TELEMETRY_EVENT_NAMES } from "../core/src/telemetry/inventory.ts";

export interface TelemetryInventoryOffender {
  readonly file: string;
  readonly line: number;
  readonly event: string;
}

export interface TelemetryInventoryResult {
  readonly ok: boolean;
  readonly offenders: ReadonlyArray<TelemetryInventoryOffender>;
}

interface CheckTelemetryInventoryOptions {
  readonly root?: string;
}

const repoRoot = resolve(import.meta.dirname, "..");

const SCANNED_ROOTS = ["core/src", "sdk/src", "plugins"] as const;

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
      if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts")) {
        files.push(full);
      }
    }

    return files;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
};

const stringLiteralValue = (node: ts.Expression): string | undefined => {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
};

const recordedEvent = (node: ts.CallExpression, source: ts.SourceFile): string | undefined => {
  const expression = node.expression;
  if (!ts.isPropertyAccessExpression(expression)) return undefined;
  if (expression.name.text !== "record") return undefined;
  if (!/telemetry/i.test(expression.expression.getText(source))) return undefined;

  const [first] = node.arguments;
  if (first === undefined) return undefined;
  return stringLiteralValue(first);
};

const scanFile = async (file: string): Promise<ReadonlyArray<TelemetryInventoryOffender>> => {
  const sourceText = await Bun.file(file).text();
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const offenders: TelemetryInventoryOffender[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const event = recordedEvent(node, source);
      if (event !== undefined && !TELEMETRY_EVENT_NAMES.has(event)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        offenders.push({ file, line: line + 1, event });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return offenders;
};

export const checkTelemetryInventory = async (
  options: CheckTelemetryInventoryOptions = {},
): Promise<TelemetryInventoryResult> => {
  const root = resolve(options.root ?? repoRoot);
  const files = (
    await Promise.all(SCANNED_ROOTS.map((scannedRoot) => collectTsFiles(resolve(root, scannedRoot))))
  )
    .flat()
    .sort();

  const offenders = (await Promise.all(files.map((file) => scanFile(file))))
    .flat()
    .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);

  return { ok: offenders.length === 0, offenders };
};

const formatOffender = (root: string, offender: TelemetryInventoryOffender): string =>
  `${relative(root, offender.file).replaceAll("\\", "/")}:${offender.line}: telemetry event "${offender.event}" is not in the inventory`;

if (import.meta.main) {
  const result = await checkTelemetryInventory({ root: repoRoot });
  if (result.ok) {
    process.stdout.write("Telemetry inventory check passed.\n");
  } else {
    process.stderr.write(
      `Telemetry inventory check failed. Every recorded event must be declared in core/src/telemetry/inventory.ts and documented in docs/telemetry/events.md in the same change.\n${result.offenders
        .map((offender) => formatOffender(repoRoot, offender))
        .join("\n")}\n`,
    );
    process.exitCode = 1;
  }
}
