import { dirname } from "node:path";
import { mapFailures } from "@lando/sdk/command-result";
import { BunShellScriptFrontMatterError, LandofileParseError, NotImplementedError } from "@lando/sdk/errors";
import { BunShellScriptFrontMatter, validationIssue, validationIssuesFromCause } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { sourceCoordinates } from "./lint-source.ts";
import { parseLandofile } from "./parser.ts";

export const FRONT_MATTER_REMEDIATION = `Wrap the front-matter in \`# ---\` markers, prefix every line with \`# \`, and use only ${Object.keys(BunShellScriptFrontMatter.fields).join(", ")}.`;

export interface BunShellFrontMatterProblem {
  readonly file: string;
  readonly path: readonly (string | number)[];
  readonly message: string;
  readonly line?: number;
  readonly column?: number;
  readonly suggestion: string;
  readonly error: BunShellScriptFrontMatterError | NotImplementedError;
}

const UNSUPPORTED_KEYS = new Set([
  "aliases",
  "topLevelAlias",
  "bootstrap",
  "passThrough",
  "sources",
  "generates",
  "status",
  "preconditions",
  "run",
  "platforms",
  "internal",
  "engine",
]);

const isFence = (line: string): boolean => line.trimEnd() === "# ---";

interface FrontMatterRegion {
  readonly start: number;
  readonly body: readonly string[];
}

const findRegion = (lines: readonly string[]): FrontMatterRegion | "missing" | "malformed" => {
  let start = lines[0]?.startsWith("#!") === true ? 1 : 0;
  while (start < lines.length && lines[start]?.trim() === "") start++;
  const opening = lines[start];
  if (opening === undefined || !isFence(opening)) return "missing";
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (isFence(line)) return { start, body };
    if (line === "#") body.push("");
    else if (line.startsWith("# ")) body.push(line.slice(2));
    else return "malformed";
  }
  return "malformed";
};

export const bunShellFrontMatterCoordinates = (content: string, path: readonly (string | number)[]) => {
  const region = findRegion(content.split(/\r?\n/));
  if (typeof region === "string") return {};
  const location = sourceCoordinates(
    { form: "yaml", content: "\n".repeat(region.start + 1) + region.body.join("\n") },
    path,
  );
  return { ...location, ...(location.column === undefined ? {} : { column: location.column + 2 }) };
};

export const inspectBunShellScriptFrontMatter = Effect.fnUntraced(function* (
  scriptPath: string,
  content: string,
): Effect.fn.Return<{
  readonly frontMatter?: BunShellScriptFrontMatter;
  readonly problems: readonly BunShellFrontMatterProblem[];
}> {
  const region = findRegion(content.split(/\r?\n/));
  const problem = (
    error: BunShellScriptFrontMatterError | NotImplementedError,
    path: readonly (string | number)[] = [],
  ): BunShellFrontMatterProblem => ({
    file: scriptPath,
    path,
    message: error.message,
    suggestion: error.remediation,
    error,
  });
  if (typeof region === "string") {
    const error = new BunShellScriptFrontMatterError({
      message:
        region === "missing"
          ? `.bun.sh script at ${scriptPath} is missing the front-matter block.`
          : `.bun.sh script at ${scriptPath} has a malformed front-matter block.`,
      path: scriptPath,
      remediation: FRONT_MATTER_REMEDIATION,
    });
    return { problems: [problem(error)] };
  }

  // Blank padding keeps YAML error lines in physical script coordinates.
  const contentYaml = "\n".repeat(region.start + 1) + region.body.join("\n");
  const parsedResult = yield* parseLandofile({
    file: scriptPath,
    cwd: dirname(scriptPath),
    content: contentYaml,
  }).pipe(
    mapFailures((cause) => {
      const column = cause.column === undefined ? undefined : cause.column + 2;
      const location =
        cause.line === undefined
          ? ""
          : `line ${cause.line}${column === undefined ? "" : `, column ${column}`}: `;
      return new BunShellScriptFrontMatterError({
        message: `.bun.sh front-matter at ${scriptPath} is malformed.`,
        path: scriptPath,
        issues: [validationIssue([], `${location}${cause.message}`)],
        remediation: FRONT_MATTER_REMEDIATION,
        cause: new LandofileParseError({
          message: cause.message,
          filePath: scriptPath,
          line: cause.line,
          column,
          remediation: cause.remediation,
        }),
      });
    }),
    Effect.result,
  );
  if (parsedResult._tag === "Failure") {
    const error = parsedResult.failure;
    const cause = error.cause;
    return {
      problems: [
        {
          ...problem(error),
          ...(cause instanceof LandofileParseError && cause.line !== undefined ? { line: cause.line } : {}),
          ...(cause instanceof LandofileParseError && cause.column !== undefined
            ? { column: cause.column }
            : {}),
        },
      ],
    };
  }
  const parsed = parsedResult.success;
  const problems: BunShellFrontMatterProblem[] = [];
  if (typeof parsed === "object" && parsed !== null) {
    for (const unsupported of Object.keys(parsed).filter((key) => UNSUPPORTED_KEYS.has(key))) {
      const error = new NotImplementedError({
        message: `.bun.sh front-matter field "${unsupported}:" at ${scriptPath} is not supported.`,
        commandId: "landofile.parse",
        remediation: "Remove the field from the .bun.sh front-matter; this surface is not supported.",
      });
      problems.push({
        ...problem(error, [unsupported]),
        ...bunShellFrontMatterCoordinates(content, [unsupported]),
      });
    }
  }
  const decoded = yield* Schema.decodeUnknownEffect(BunShellScriptFrontMatter)(parsed, {
    onExcessProperty: "error",
    errors: "all",
  }).pipe(
    mapFailures(
      (cause) =>
        new BunShellScriptFrontMatterError({
          message: `.bun.sh front-matter at ${scriptPath} is malformed.`,
          path: scriptPath,
          issues: validationIssuesFromCause(cause, { fallback: "Invalid .bun.sh front-matter." }),
          remediation: FRONT_MATTER_REMEDIATION,
        }),
    ),
    Effect.result,
  );
  if (decoded._tag === "Failure") {
    for (const issue of decoded.failure.issues ?? []) {
      if (typeof issue.path[0] === "string" && UNSUPPORTED_KEYS.has(issue.path[0])) continue;
      problems.push({
        ...problem(decoded.failure, issue.path),
        message: issue.message,
        suggestion: issue.suggestion ?? decoded.failure.remediation,
        ...bunShellFrontMatterCoordinates(content, issue.path),
      });
    }
  }
  return { ...(decoded._tag === "Success" ? { frontMatter: decoded.success } : {}), problems };
});

export const parseBunShellScriptFrontMatter = Effect.fnUntraced(function* (
  scriptPath: string,
  content: string,
): Effect.fn.Return<BunShellScriptFrontMatter, BunShellScriptFrontMatterError | NotImplementedError> {
  const inspected = yield* inspectBunShellScriptFrontMatter(scriptPath, content);
  const first = inspected.problems[0];
  if (first !== undefined) return yield* Effect.fail(first.error);
  if (inspected.frontMatter !== undefined) return inspected.frontMatter;
  return yield* Effect.die("Front matter inspection returned neither metadata nor problems.");
});
