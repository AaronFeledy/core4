import { dirname } from "node:path";
import { type LandofileParseError, NotImplementedError } from "@lando/sdk/errors";
import { expressionInterpolationsTouchOnlyScopes, parseExpressionEither } from "@lando/sdk/expressions";
import { isPlainRecord } from "@lando/sdk/landofile";
import { Effect, Result } from "effect";
import { parseLandofile } from "./parser.ts";
import { LOAD_DEFERRED_EXPRESSION_SCOPES } from "./recipe-expressions.ts";
import { withoutSecretReferences } from "./secret-reference.ts";
import { UNSUPPORTED_REMEDIATION } from "./tooling-unsupported.ts";

const quotedStrings = (content: string): ReadonlyArray<string> =>
  [...content.matchAll(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g)].map((match) => match[0]);

const isDeferredScopeTemplate = (value: string): boolean => {
  const parsed = parseExpressionEither(value, { filePath: "<landofile>" });
  return (
    Result.isSuccess(parsed) &&
    expressionInterpolationsTouchOnlyScopes(parsed.success, LOAD_DEFERRED_EXPRESSION_SCOPES)
  );
};

const scanForConfigExpression = (content: string): { description: string } | undefined => {
  const withoutComments = content
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*#.*$/, "").replace(/\s+#.*$/, ""))
    .join("\n");
  if (/\$\{[A-Za-z_]/.test(withoutSecretReferences(withoutComments))) {
    return { description: "Configuration expressions (${...})" };
  }
  if (!/\{\{/.test(withoutComments)) return undefined;
  const quoted = quotedStrings(withoutComments);
  for (const token of quoted) {
    const inner = token.slice(1, -1);
    if (inner.includes("{{") && !isDeferredScopeTemplate(inner)) {
      return { description: "Template expressions ({{ ... }})" };
    }
  }
  let remainder = withoutComments;
  for (const token of quoted) remainder = remainder.replace(token, " ");
  return /\{\{/.test(remainder) ? { description: "Template expressions ({{ ... }})" } : undefined;
};

const parsedStrings = (value: unknown): ReadonlyArray<string> => {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(parsedStrings);
  if (!isPlainRecord(value)) return [];
  return Object.entries(value).flatMap(([key, entry]) => [key, ...parsedStrings(entry)]);
};

export const parseSupportedLandofileSource = (
  filePath: string,
  content: string,
): Effect.Effect<unknown, LandofileParseError | NotImplementedError> => {
  const parsedSource = parseLandofile({ file: filePath, content, cwd: dirname(filePath) });
  const match = scanForConfigExpression(content);
  if (match === undefined || content.includes("load(") || content.includes("import(")) {
    return parsedSource;
  }
  const unsupported = Effect.fail(
    new NotImplementedError({
      message: `${match.description} are not supported at ${filePath}.`,
      commandId: "landofile.parse",
      remediation: UNSUPPORTED_REMEDIATION,
    }),
  );
  if (!content.includes("!reset")) return unsupported;
  // Reset payloads are discarded without evaluation.
  return parsedSource.pipe(
    Effect.matchEffect({
      onFailure: () => unsupported,
      onSuccess: (parsed) =>
        parsedStrings(parsed).some((value) => scanForConfigExpression(JSON.stringify(value)) !== undefined)
          ? unsupported
          : Effect.succeed(parsed),
    }),
  );
};
