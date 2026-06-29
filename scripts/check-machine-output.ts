import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import ts from "typescript";

export interface MachineOutputOffender {
  readonly file: string;
  readonly line: number;
  readonly match: string;
}

export interface MachineOutputResult {
  readonly ok: boolean;
  readonly offenders: ReadonlyArray<MachineOutputOffender>;
}

interface CheckMachineOutputOptions {
  readonly root?: string;
}

const repoRoot = resolve(import.meta.dirname, "..");

const SCANNED_ROOTS = ["core/src", "plugins"] as const;
const CARVE_OUTS = new Set<string>(["core/src/cli/result-encode.ts"]);

const COMMAND_SPEC_SHAPE_KEYS = ["id", "summary", "namespace", "bootstrap", "run"] as const;

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

const directProperties = (node: ts.ObjectLiteralExpression): Map<string, ts.Expression> => {
  const props = new Map<string, ts.Expression>();
  for (const member of node.properties) {
    if (ts.isPropertyAssignment(member)) {
      const name = propertyName(member.name);
      if (name !== undefined) props.set(name, member.initializer);
    } else if (ts.isShorthandPropertyAssignment(member)) {
      props.set(member.name.text, member.name);
    }
  }
  return props;
};

const isStringLiteralValue = (node: ts.Expression, value: string): boolean =>
  (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === value;

/** CommandResultEnvelope shape: direct keys apiVersion + command + ok + (result | error). */
const isCommandEnvelopeLiteral = (node: ts.Node): boolean => {
  if (!ts.isObjectLiteralExpression(node)) return false;
  const props = directProperties(node);
  if (!props.has("apiVersion") || !props.has("command") || !props.has("ok")) return false;
  if (!props.has("result") && !props.has("error")) return false;
  const apiVersion = props.get("apiVersion");
  if (apiVersion !== undefined && ts.isStringLiteralLike(apiVersion) && apiVersion.text !== "v4")
    return false;
  return true;
};

/** Result StreamFrame shape: direct `_tag: "result"` string literal + direct `envelope` key. */
const isStreamResultFrameLiteral = (node: ts.Node): boolean => {
  if (!ts.isObjectLiteralExpression(node)) return false;
  const props = directProperties(node);
  const tag = props.get("_tag");
  if (tag === undefined || !props.has("envelope")) return false;
  if (isStringLiteralValue(tag, "result")) return true;
  if (ts.isAsExpression(tag) && isStringLiteralValue(tag.expression, "result")) return true;
  return false;
};

const localInitializer = (name: string, scope: ts.Node): ts.Expression | undefined => {
  let found: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (found !== undefined) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      if (node.initializer !== undefined) found = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return found;
};

type ResultShape = "envelope" | "frame";

const resultShapeOf = (node: ts.Node, scope: ts.Node, seen: Set<ts.Node>): ResultShape | undefined => {
  if (seen.has(node)) return undefined;
  seen.add(node);

  if (isStreamResultFrameLiteral(node)) return "frame";
  if (isCommandEnvelopeLiteral(node)) return "envelope";

  if (ts.isIdentifier(node)) {
    const initializer = localInitializer(node.text, scope);
    if (initializer !== undefined) return resultShapeOf(initializer, scope, seen);
    return undefined;
  }

  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return resultShapeOf(node.expression, scope, seen);
  }

  let shape: ResultShape | undefined;
  ts.forEachChild(node, (child) => {
    if (shape !== undefined) return;
    shape = resultShapeOf(child, scope, seen);
  });
  return shape;
};

const isJsonStringifyCall = (node: ts.CallExpression): boolean => {
  const expression = node.expression;
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "JSON" &&
    expression.name.text === "stringify"
  );
};

const matchTextForShape = (node: ts.CallExpression, shape: ResultShape): string => {
  const arg = node.arguments[0];
  if (arg !== undefined && ts.isIdentifier(arg)) return `JSON.stringify(${arg.text})`;
  return shape === "frame"
    ? "JSON.stringify(<result-stream-frame>)"
    : "JSON.stringify(<command-result-envelope>)";
};

const typeReferenceName = (node: ts.TypeNode | undefined): string | undefined => {
  if (node !== undefined && ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
    return node.typeName.text;
  }
  return undefined;
};

const isCommandSpecAnnotated = (node: ts.ObjectLiteralExpression): boolean => {
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && typeReferenceName(parent.type) === "LandoCommandSpec") return true;
  if (ts.isPropertyDeclaration(parent) && typeReferenceName(parent.type) === "LandoCommandSpec") return true;
  if (
    (ts.isAsExpression(parent) || ts.isSatisfiesExpression(parent)) &&
    typeReferenceName(parent.type) === "LandoCommandSpec"
  ) {
    return true;
  }
  return false;
};

const isCommandSpecLiteral = (
  node: ts.ObjectLiteralExpression,
  props: Map<string, ts.Expression>,
): boolean => {
  if (isCommandSpecAnnotated(node)) return true;
  return COMMAND_SPEC_SHAPE_KEYS.every((key) => props.has(key));
};

const commandIdOf = (props: Map<string, ts.Expression>): string => {
  const id = props.get("id");
  return id !== undefined && ts.isStringLiteralLike(id) ? id.text : "<command>";
};

const missingResultSchema = (props: Map<string, ts.Expression>): boolean => {
  if (!props.has("resultSchema")) return true;
  const value = props.get("resultSchema");
  if (value === undefined) return true;
  if (ts.isIdentifier(value) && value.text === "undefined") return true;
  if (value.kind === ts.SyntaxKind.NullKeyword) return true;
  return false;
};

const scanFile = async (file: string): Promise<ReadonlyArray<MachineOutputOffender>> => {
  const sourceText = await Bun.file(file).text();
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const offenders: MachineOutputOffender[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isJsonStringifyCall(node) && node.arguments[0] !== undefined) {
      const shape = resultShapeOf(node.arguments[0], source, new Set());
      if (shape !== undefined) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        offenders.push({ file, line: line + 1, match: matchTextForShape(node, shape) });
      }
    }

    if (ts.isObjectLiteralExpression(node)) {
      const props = directProperties(node);
      if (isCommandSpecLiteral(node, props) && missingResultSchema(props)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        offenders.push({
          file,
          line: line + 1,
          match: `${commandIdOf(props)} (missing resultSchema)`,
        });
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
  return offenders;
};

export const checkMachineOutput = async (
  options: CheckMachineOutputOptions = {},
): Promise<MachineOutputResult> => {
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

const formatOffender = (root: string, offender: MachineOutputOffender): string =>
  `${relative(root, offender.file).replaceAll("\\", "/")}:${offender.line}: ${offender.match}`;

if (import.meta.main) {
  const result = await checkMachineOutput({ root: repoRoot });
  if (result.ok) {
    process.stdout.write("Machine output boundary check passed.\n");
  } else {
    process.stderr.write(
      `Machine output boundary check failed. Command-result envelopes must serialize only through encodeCommandResult, and every command spec must declare a resultSchema.\n${result.offenders
        .map((offender) => formatOffender(repoRoot, offender))
        .join("\n")}\n`,
    );
    process.exitCode = 1;
  }
}
