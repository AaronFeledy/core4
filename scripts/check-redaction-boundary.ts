import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import ts from "typescript";

export interface RedactionBoundaryOffender {
  readonly file: string;
  readonly line: number;
  readonly match: string;
}

export interface RedactionBoundaryResult {
  readonly ok: boolean;
  readonly offenders: ReadonlyArray<RedactionBoundaryOffender>;
}

interface CheckRedactionBoundaryOptions {
  readonly root?: string;
}

const repoRoot = resolve(import.meta.dirname, "..");

const SCANNED_ROOTS = ["core/src", "plugins"] as const;
const CARVE_OUTS = new Set<string>([]);

const SENTINEL_TEXTS = new Set(["[redacted]", "[REDACTED]"]);

/**
 * Returns true when a regex literal source string looks like an ad-hoc
 * secret-redaction pattern.  Conservative: requires a multi-signal match to
 * avoid false positives on ordinary URL or token-path regexes.
 */
const isAdHocSecretRegex = (src: string): boolean => {
  const lower = src.toLowerCase();

  // Signal 1: bearer/authorization header pattern
  // "bearer" followed by \s or whitespace-class intent, or the word "authorization"
  if (/bearer[\s\\]/.test(lower) || lower.includes("authorization")) return true;

  // Signal 2: URL userinfo credential shape — contains @ AND a credential-ish
  // capture group like [^@...] or :[^ — i.e. `:` then `@` with char-class between
  if (src.includes("@") && (src.includes("[^@") || src.includes(":[^"))) return true;

  // Signal 3: signed-query shape — [?&] near a secret keyword followed by =
  if (/\[\?&\].*(?:token|api_key|apikey|access_token|password|secret|credential|signature)\s*=/.test(lower)) {
    return true;
  }

  // Signal 4: two or more secret-key alternation keywords (clearly a secret-key regex)
  const secretKeywords = [
    "password",
    "passwd",
    "secret",
    "token",
    "credential",
    "bearer",
    "apikey",
    "api_key",
  ];
  let keywordCount = 0;
  for (const kw of secretKeywords) {
    if (lower.includes(kw)) keywordCount++;
    if (keywordCount >= 2) return true;
  }

  return false;
};

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

const scanFile = async (file: string): Promise<ReadonlyArray<RedactionBoundaryOffender>> => {
  const sourceText = await Bun.file(file).text();
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const offenders: RedactionBoundaryOffender[] = [];

  const visit = (node: ts.Node): void => {
    // Sentinel string literals: exact whole-string match on [redacted] or [REDACTED]
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (SENTINEL_TEXTS.has(node.text)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        offenders.push({ file, line: line + 1, match: node.text });
      }
    }

    // Ad-hoc secret regex literals
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      const regexNode = node as ts.RegularExpressionLiteral;
      if (isAdHocSecretRegex(regexNode.text)) {
        const { line } = source.getLineAndCharacterOfPosition(regexNode.getStart(source));
        offenders.push({ file, line: line + 1, match: regexNode.text });
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
  return offenders;
};

export const checkRedactionBoundary = async (
  options: CheckRedactionBoundaryOptions = {},
): Promise<RedactionBoundaryResult> => {
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

const formatOffender = (root: string, offender: RedactionBoundaryOffender): string =>
  `${relative(root, offender.file).replaceAll("\\", "/")}:${offender.line}: ${offender.match}`;

if (import.meta.main) {
  const result = await checkRedactionBoundary({ root: repoRoot });
  if (result.ok) {
    process.stdout.write("Redaction boundary check passed.\n");
  } else {
    process.stderr.write(
      `Redaction boundary check failed. Redaction sentinels and ad-hoc secret-matching regexes must route through @lando/sdk/secrets.\n${result.offenders
        .map((offender) => formatOffender(repoRoot, offender))
        .join("\n")}\n`,
    );
    process.exitCode = 1;
  }
}
