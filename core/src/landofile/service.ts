import { dirname, join } from "node:path";

import { Cause, type Context, Effect, Layer, ParseResult } from "effect";

import {
  LandofileFormConflictError,
  type LandofileIncludeError,
  type LandofileLockMismatchError,
  LandofileNotFoundError,
  LandofileParseError,
  type LandofileSandboxError,
  type LandofileTimeoutError,
  LandofileValidationError,
  NotImplementedError,
} from "@lando/sdk/errors";
import { LandofileShape, ServiceConfig } from "@lando/sdk/schema";
import { LandofileService } from "@lando/sdk/services";

import {
  getVersionConstraintEntries,
  isValidSemverRange,
  rememberVersionConstraintEntries,
} from "../config/version-constraint.ts";
import { decodeOrFail } from "../schema/decode.ts";
import { LANDOFILE_NAME } from "./discovery.ts";
import { getLocalIncludePaths, rememberLocalIncludePaths } from "./include-provenance.ts";
import { resolveLandofileIncludes } from "./includes.ts";
import { landofileLayerPaths, presentLandofileLayers, representativeLandofileLayer } from "./layers.ts";
import { mergeLandofiles } from "./merge.ts";
import { parseLandofile } from "./parser.ts";
import { renderLandofileTemplate } from "./template-render.ts";
import { BETA_REMEDIATION, rejectBetaToolingFeatures } from "./tooling-beta.ts";
import { loadLandofileTs } from "./ts-loader.ts";

export { LandofileService } from "@lando/sdk/services";

const REMEDIATION = "Remove unsupported keys or update the documented Landofile service schema.";
const COMPOSE_ALLOWLIST_REMEDIATION =
  "Compose compatibility is limited to the supported subset; move provider-native keys under providers.<provider-id> or use config translation.";

const SERVICE_CONFIG_KEYS = new Set(Object.keys(ServiceConfig.fields));

const BETA_TOP_LEVEL_KEYS: ReadonlyArray<{
  key: string;
  description: string;
}> = [
  { key: "env_file", description: "Landofile env file overrides" },
  { key: "toolingDefaults", description: "Tooling defaults" },
  { key: "toolingIncludes", description: "Tooling includes" },
  { key: "events", description: "Events-as-tasks" },
  { key: "commandAliases", description: "Top-level command aliases" },
];

const scanForBetaTopLevelKey = (parsed: unknown): { key: string; description: string } | undefined => {
  if (parsed === null || typeof parsed !== "object") return undefined;
  const obj = parsed as Record<string, unknown>;
  for (const entry of BETA_TOP_LEVEL_KEYS) {
    if (Object.hasOwn(obj, entry.key)) return entry;
  }
  return undefined;
};

const CONFIG_EXPRESSION_PATTERN = /\$\{[A-Za-z_]/;
const TEMPLATE_EXPRESSION_PATTERN = /\{\{/;

const scanForConfigExpression = (content: string): { description: string } | undefined => {
  const withoutComments = content
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*#.*$/, "").replace(/\s+#.*$/, ""))
    .join("\n");
  if (CONFIG_EXPRESSION_PATTERN.test(withoutComments)) {
    return { description: "Configuration expressions (${...})" };
  }
  if (TEMPLATE_EXPRESSION_PATTERN.test(withoutComments)) {
    return { description: "Template expressions ({{ ... }})" };
  }
  return undefined;
};

type LandofileForm = "yaml" | "typescript";

interface DiscoveredLandofile {
  readonly filePath: string;
  readonly form: LandofileForm;
  readonly searched: ReadonlyArray<string>;
}

const findLandofile = async (cwd: string): Promise<DiscoveredLandofile> => {
  const searched: string[] = [];
  let current = cwd;

  for (;;) {
    const candidates = landofileLayerPaths(current);
    searched.push(...candidates.flatMap(({ yamlPath, typescriptPath }) => [yamlPath, typescriptPath]));
    const layer = representativeLandofileLayer(await presentLandofileLayers(current));
    if (layer !== undefined) {
      return {
        filePath: layer.filePath,
        form: layer.filePath.endsWith(".ts") ? "typescript" : "yaml",
        searched,
      };
    }

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  throw new LandofileNotFoundError({
    message: `No .lando.yml or .lando.ts found. Searched: ${searched.join(", ")}`,
    cwd,
  });
};

export const findDiscoveredLandofilePath = async (
  cwd: string,
): Promise<{ readonly filePath: string; readonly appRoot: string }> => {
  const discovered = await findLandofile(cwd);
  return { filePath: discovered.filePath, appRoot: dirname(discovered.filePath) };
};

const extractFailure = <E>(cause: Cause.Cause<E>): E | undefined => {
  const failure = Cause.failureOption(cause);
  return failure._tag === "Some" ? failure.value : undefined;
};

const validationIssues = (cause: unknown): ReadonlyArray<string> => {
  if (ParseResult.isParseError(cause)) {
    return ParseResult.ArrayFormatter.formatErrorSync(cause).map((issue) =>
      issue.path.length === 0 ? issue.message : issue.path.join("."),
    );
  }
  return [cause instanceof Error ? cause.message : "Invalid Landofile."];
};

const unsupportedAuthoredServiceKeyTypes = (
  parsed: unknown,
): { readonly compose: number; readonly nonCompose: number } => {
  if (parsed === null || typeof parsed !== "object") return { compose: 0, nonCompose: 0 };
  const services = (parsed as { readonly services?: unknown }).services;
  if (services === null || typeof services !== "object") return { compose: 0, nonCompose: 0 };

  let compose = 0;
  let nonCompose = 0;
  for (const service of Object.values(services as Record<string, unknown>)) {
    if (service === null || typeof service !== "object") continue;
    const serviceRecord = service as Record<string, unknown>;
    const hasUnsupportedKey = Object.keys(serviceRecord).some((key) => !SERVICE_CONFIG_KEYS.has(key));
    if (!hasUnsupportedKey) continue;
    if (serviceRecord.type === "compose") compose++;
    else nonCompose++;
  }
  return { compose, nonCompose };
};

const validationScope = (parsed: unknown): { readonly scope: string; readonly remediation: string } => {
  const unsupportedKeyTypes = unsupportedAuthoredServiceKeyTypes(parsed);
  if (unsupportedKeyTypes.compose > 0 && unsupportedKeyTypes.nonCompose === 0) {
    return { scope: "unsupported Compose-subset keys", remediation: COMPOSE_ALLOWLIST_REMEDIATION };
  }
  if (unsupportedKeyTypes.compose > 0 && unsupportedKeyTypes.nonCompose > 0) {
    return {
      scope: "unsupported service keys",
      remediation: `${REMEDIATION} For type: compose services, ${COMPOSE_ALLOWLIST_REMEDIATION}`,
    };
  }
  return { scope: "unsupported MVP keys", remediation: REMEDIATION };
};

const validateLandofile = (
  filePath: string,
  parsed: unknown,
): Effect.Effect<typeof LandofileShape.Type, LandofileValidationError | LandofileParseError> => {
  const authoredRange =
    parsed !== null && typeof parsed === "object" && "lando" in parsed
      ? (parsed as { readonly lando?: unknown }).lando
      : undefined;
  if (typeof authoredRange === "string" && !isValidSemverRange(authoredRange)) {
    return Effect.fail(
      new LandofileParseError({
        message: `Landofile "lando:" is not a valid semver range: "${authoredRange}". Use npm semver syntax such as ">=4.1 <5", "^4", or "4.x".`,
        filePath,
        line: undefined,
        column: undefined,
      }),
    );
  }
  return decodeOrFail(LandofileShape, (cause) => {
    const issues = validationIssues(cause);
    const { scope, remediation } = validationScope(parsed);
    return new LandofileValidationError({
      message: `Landofile contains ${scope}: ${issues.join(", ")}. ${remediation}`,
      file: filePath,
      issues,
    });
  })(parsed, { onExcessProperty: "error" });
};

const scanContentForBetaExpressions = (
  filePath: string,
  content: string,
): Effect.Effect<string, NotImplementedError> => {
  const match = scanForConfigExpression(content);
  if (match === undefined) return Effect.succeed(content);
  return Effect.fail(
    new NotImplementedError({
      message: `${match.description} are not supported in Alpha Landofiles at ${filePath}.`,
      commandId: "landofile.parse",
      remediation: BETA_REMEDIATION,
    }),
  );
};

const rejectBetaTopLevelKeys = (
  filePath: string,
  parsed: unknown,
): Effect.Effect<unknown, NotImplementedError> => {
  const beta = scanForBetaTopLevelKey(parsed);
  if (beta === undefined) return Effect.succeed(parsed);
  return Effect.fail(
    new NotImplementedError({
      message: `Top-level "${beta.key}:" is not supported in Alpha Landofiles at ${filePath}.`,
      commandId: "landofile.parse",
      remediation: BETA_REMEDIATION,
    }),
  );
};

type LandofileLoadError =
  | LandofileNotFoundError
  | LandofileParseError
  | LandofileValidationError
  | LandofileSandboxError
  | LandofileTimeoutError
  | LandofileFormConflictError
  | LandofileIncludeError
  | LandofileLockMismatchError
  | NotImplementedError;

export const loadLandofileFile = (
  filePath: string,
): Effect.Effect<typeof LandofileShape.Type, LandofileLoadError> =>
  (filePath.endsWith(".ts") ? loadTsLandofile(filePath) : loadYamlLandofile(filePath)).pipe(
    Effect.flatMap((parsed) => validateLandofile(filePath, parsed)),
  );

const readFileContent = (filePath: string): Effect.Effect<string, LandofileParseError> =>
  Effect.tryPromise({
    try: async () => Bun.file(filePath).text(),
    catch: (cause) =>
      new LandofileParseError({
        message: cause instanceof Error ? cause.message : `Failed to read ${filePath}`,
        filePath,
        line: undefined,
        column: undefined,
        cause,
      }),
  });

const loadYamlLandofile = (
  filePath: string,
): Effect.Effect<unknown, LandofileParseError | NotImplementedError> =>
  readFileContent(filePath).pipe(
    Effect.flatMap((content) => renderLandofileTemplate({ filePath, content })),
    Effect.flatMap((content) => scanContentForBetaExpressions(filePath, content)),
    Effect.flatMap((content) => parseLandofile({ file: filePath, content, cwd: dirname(filePath) })),
    Effect.flatMap((parsed) => rejectBetaTopLevelKeys(filePath, parsed)),
    Effect.flatMap((parsed) => rejectBetaToolingFeatures(filePath, parsed)),
  );

const loadTsLandofile = (
  filePath: string,
): Effect.Effect<
  unknown,
  LandofileParseError | LandofileSandboxError | LandofileTimeoutError | NotImplementedError
> =>
  readFileContent(filePath).pipe(
    Effect.flatMap((content) => loadLandofileTs({ filePath, appRoot: dirname(filePath), content })),
    Effect.flatMap((parsed) => rejectBetaTopLevelKeys(filePath, parsed)),
    Effect.flatMap((parsed) => rejectBetaToolingFeatures(filePath, parsed)),
  );

export const loadLandofileLayers = (
  appRoot: string,
  canonicalPath: string,
): Effect.Effect<typeof LandofileShape.Type, LandofileLoadError> =>
  Effect.tryPromise({
    try: () => presentLandofileLayers(appRoot),
    catch: (cause) =>
      cause instanceof LandofileFormConflictError
        ? cause
        : new LandofileParseError({
            message: cause instanceof Error ? cause.message : "Failed to enumerate Landofile layers.",
            filePath: canonicalPath,
            line: undefined,
            column: undefined,
            cause,
          }),
  }).pipe(
    Effect.flatMap((layers) =>
      Effect.forEach(layers, (layer) =>
        loadLandofileFile(layer.filePath).pipe(
          Effect.flatMap((landofile) =>
            resolveLandofileIncludes({
              landofile,
              appRoot,
              sourcePath: layer.filePath,
              layer: layer.layer,
              order: layer.order,
            }),
          ),
          Effect.map((landofile) => ({ layer, landofile })),
        ),
      ),
    ),
    Effect.flatMap((loaded) => {
      const merged = mergeLandofiles(loaded.map(({ landofile }) => landofile as Record<string, unknown>));
      return validateLandofile(canonicalPath, merged).pipe(
        Effect.map((landofile) =>
          rememberLocalIncludePaths(
            rememberVersionConstraintEntries(
              landofile,
              loaded.flatMap(({ landofile, layer }) =>
                getVersionConstraintEntries(landofile, layer.filePath),
              ),
            ),
            loaded.flatMap(({ landofile }) => getLocalIncludePaths(landofile)),
          ),
        ),
      );
    }),
  );

const discoverLandofile: Effect.Effect<typeof LandofileShape.Type, LandofileLoadError> = Effect.tryPromise({
  try: async () => findLandofile(process.cwd()),
  catch: (cause) => {
    if (cause instanceof LandofileNotFoundError) return cause;
    if (cause instanceof LandofileFormConflictError) return cause;
    if (cause instanceof LandofileParseError) return cause;
    return new LandofileParseError({
      message: cause instanceof Error ? cause.message : "Failed to discover Landofile.",
      filePath: join(process.cwd(), LANDOFILE_NAME),
      line: undefined,
      column: undefined,
      cause,
    });
  },
}).pipe(
  Effect.flatMap(({ filePath }) => loadLandofileLayers(dirname(filePath), filePath)),
  Effect.catchAllCause((cause) => {
    const failure = extractFailure(cause);
    if (failure !== undefined) return Effect.fail(failure);
    return Effect.fail(
      new LandofileParseError({
        message: "Failed to load Landofile.",
        filePath: join(process.cwd(), LANDOFILE_NAME),
        line: undefined,
        column: undefined,
        cause,
      }),
    );
  }),
);

const landofileService: Context.Tag.Service<typeof LandofileService> = {
  discover: discoverLandofile,
};

export const LandofileServiceLive = Layer.succeed(LandofileService, landofileService);
