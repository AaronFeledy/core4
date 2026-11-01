import { dirname } from "node:path";
import { BunShellScriptFrontMatterError, LandofileParseError, NotImplementedError } from "@lando/sdk/errors";
import { BunShellScriptFrontMatter, validationIssue, validationIssuesFromCause } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { parseLandofile } from "./parser.ts";

export const FRONT_MATTER_REMEDIATION =
  "Wrap the front-matter in `# ---` markers, prefix every line with `# `, and use only service, desc, description, summary, flags, args, disabled.";

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

export const parseBunShellScriptFrontMatter = Effect.fnUntraced(function* (
  scriptPath: string,
  content: string,
): Effect.fn.Return<BunShellScriptFrontMatter, BunShellScriptFrontMatterError | NotImplementedError> {
  const region = findRegion(content.split(/\r?\n/));
  if (typeof region === "string")
    return yield* Effect.fail(
      new BunShellScriptFrontMatterError({
        message:
          region === "missing"
            ? `.bun.sh script at ${scriptPath} is missing the front-matter block.`
            : `.bun.sh script at ${scriptPath} has a malformed front-matter block.`,
        path: scriptPath,
        remediation: FRONT_MATTER_REMEDIATION,
      }),
    );

  // Blank padding keeps YAML error lines in physical script coordinates.
  const parsed = yield* parseLandofile({
    file: scriptPath,
    cwd: dirname(scriptPath),
    content: "\n".repeat(region.start + 1) + region.body.join("\n"),
  }).pipe(
    Effect.mapError((cause) => {
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
  );
  if (typeof parsed === "object" && parsed !== null) {
    const unsupported = Object.keys(parsed).find((key) => UNSUPPORTED_KEYS.has(key));
    if (unsupported !== undefined)
      return yield* Effect.fail(
        new NotImplementedError({
          message: `.bun.sh front-matter field "${unsupported}:" at ${scriptPath} is not supported yet.`,
          commandId: "landofile.parse",
          remediation: "Remove the field from the .bun.sh front-matter; this surface is not supported yet.",
        }),
      );
  }
  return yield* Schema.decodeUnknownEffect(BunShellScriptFrontMatter)(parsed, {
    onExcessProperty: "error",
    errors: "all",
  }).pipe(
    Effect.mapError(
      (cause) =>
        new BunShellScriptFrontMatterError({
          message: `.bun.sh front-matter at ${scriptPath} is malformed.`,
          path: scriptPath,
          issues: validationIssuesFromCause(cause, { fallback: "Invalid .bun.sh front-matter." }),
          remediation: FRONT_MATTER_REMEDIATION,
        }),
    ),
  );
});
