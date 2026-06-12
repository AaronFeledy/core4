import { dirname, join } from "node:path";

import { Cause, type Context, Effect, Layer, ParseResult } from "effect";

import {
  LandofileNotFoundError,
  LandofileParseError,
  type LandofileSandboxError,
  type LandofileTimeoutError,
  LandofileValidationError,
  NotImplementedError,
} from "@lando/sdk/errors";
import { LandofileShape, ServiceConfig } from "@lando/sdk/schema";
import { LandofileService } from "@lando/sdk/services";

import { decodeOrFail } from "../schema/decode.ts";
import { parseLandofile } from "./parser.ts";
import { renderLandofileTemplate } from "./template-render.ts";
import { loadLandofileTs } from "./ts-loader.ts";

export { LandofileService } from "@lando/sdk/services";

const LANDOFILE_NAME = ".lando.yml";
const LANDOFILE_TS_NAME = ".lando.ts";
const REMEDIATION = "Remove unsupported keys or update the documented Landofile service schema.";
const COMPOSE_ALLOWLIST_REMEDIATION =
  "Compose compatibility is limited to the supported subset; move provider-native keys under providers.<provider-id> or use config translation.";

const SERVICE_CONFIG_KEYS = new Set(Object.keys(ServiceConfig.fields));

const BETA_REMEDIATION = "Remove the section; this surface is not supported yet.";

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

const BETA_TOOLING_TASK_KEYS: ReadonlyArray<{ key: string }> = [
  { key: "deps" },
  { key: "engine" },
  { key: "bootstrap" },
  { key: "dotenv" },
  { key: "env" },
  { key: "user" },
  { key: "dir" },
  { key: "appMount" },
  { key: "stdio" },
  { key: "interactive" },
  { key: "passThrough" },
  { key: "sources" },
  { key: "generates" },
  { key: "method" },
  { key: "status" },
  { key: "preconditions" },
  { key: "if" },
  { key: "run" },
  { key: "platforms" },
  { key: "prompt" },
  { key: "silent" },
  { key: "output" },
  { key: "failFast" },
  { key: "disabled" },
  { key: "aliases" },
  { key: "topLevelAlias" },
  { key: "namespace" },
  { key: "internal" },
  { key: "hostProxyAllowed" },
  { key: "examples" },
  { key: "usage" },
];

const BETA_STEP_OBJECT_KEYS = new Set(["task", "command", "defer", "for", "cmd"]);
const BETA_VAR_KEYS = new Set(["raw"]);

interface ToolingBetaFinding {
  readonly task: string;
  readonly key: string;
  readonly description: string;
}

const scanToolingInputMetadataForBeta = (
  taskName: string,
  task: Readonly<Record<string, unknown>>,
  section: "flags" | "args",
): ToolingBetaFinding | undefined => {
  const metadata = task[section];
  if (
    metadata === undefined ||
    metadata === null ||
    typeof metadata !== "object" ||
    Array.isArray(metadata)
  ) {
    return undefined;
  }

  for (const [name, value] of Object.entries(metadata as Record<string, unknown>)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return {
        task: taskName,
        key: `${section}.${name}`,
        description: `Tooling ${section} entry "${name}"`,
      };
    }

    const keys = Object.keys(value as Record<string, unknown>);
    const unsupportedKey = keys.find((key) => key !== "deprecated");
    if (unsupportedKey !== undefined) {
      return {
        task: taskName,
        key: `${section}.${name}.${unsupportedKey}`,
        description: `Tooling ${section} field "${unsupportedKey}"`,
      };
    }
    if (!Object.hasOwn(value, "deprecated")) {
      return {
        task: taskName,
        key: `${section}.${name}`,
        description: `Tooling ${section} entry "${name}" without deprecation metadata`,
      };
    }
  }

  return undefined;
};

const scanToolingForBeta = (parsed: unknown): ToolingBetaFinding | undefined => {
  if (parsed === null || typeof parsed !== "object") return undefined;
  const tooling = (parsed as Record<string, unknown>).tooling;
  if (tooling === null || typeof tooling !== "object" || Array.isArray(tooling)) return undefined;
  const toolingMap = tooling as Record<string, unknown>;

  for (const [taskName, taskValue] of Object.entries(toolingMap)) {
    if (taskValue === null || typeof taskValue !== "object" || Array.isArray(taskValue)) continue;
    const task = taskValue as Record<string, unknown>;

    for (const entry of BETA_TOOLING_TASK_KEYS) {
      if (Object.hasOwn(task, entry.key)) {
        return {
          task: taskName,
          key: entry.key,
          description: `Tooling task field "${entry.key}"`,
        };
      }
    }

    const unsupportedInputMetadata =
      scanToolingInputMetadataForBeta(taskName, task, "flags") ??
      scanToolingInputMetadataForBeta(taskName, task, "args");
    if (unsupportedInputMetadata !== undefined) return unsupportedInputMetadata;

    const cmds = task.cmds;
    if (Array.isArray(cmds)) {
      for (const step of cmds) {
        if (step !== null && typeof step === "object" && !Array.isArray(step)) {
          const stepObj = step as Record<string, unknown>;
          for (const stepKey of Object.keys(stepObj)) {
            if (BETA_STEP_OBJECT_KEYS.has(stepKey)) {
              return {
                task: taskName,
                key: `cmds[].${stepKey}`,
                description: `Step-object cmds entry "${stepKey}"`,
              };
            }
          }
        }
      }
    }

    const vars = task.vars;
    if (vars !== null && typeof vars === "object" && !Array.isArray(vars)) {
      for (const [varName, varValue] of Object.entries(vars as Record<string, unknown>)) {
        if (varValue !== null && typeof varValue === "object" && !Array.isArray(varValue)) {
          for (const varKey of Object.keys(varValue as Record<string, unknown>)) {
            if (BETA_VAR_KEYS.has(varKey)) {
              return {
                task: taskName,
                key: `vars.${varName}.${varKey}`,
                description: `Unsafe "${varKey}:" interpolation in tooling var "${varName}"`,
              };
            }
          }
        }
      }
    }
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
    const yamlCandidate = join(current, LANDOFILE_NAME);
    const tsCandidate = join(current, LANDOFILE_TS_NAME);
    searched.push(yamlCandidate, tsCandidate);

    const [yamlExists, tsExists] = await Promise.all([
      Bun.file(yamlCandidate).exists(),
      Bun.file(tsCandidate).exists(),
    ]);

    if (yamlExists && tsExists) {
      throw new LandofileParseError({
        message: `Both ${LANDOFILE_NAME} and ${LANDOFILE_TS_NAME} are present in ${current}. Pick one form per directory and remove the other.`,
        filePath: tsCandidate,
        line: undefined,
        column: undefined,
      });
    }
    if (yamlExists) return { filePath: yamlCandidate, form: "yaml", searched };
    if (tsExists) return { filePath: tsCandidate, form: "typescript", searched };

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  throw new LandofileNotFoundError({
    message: `No ${LANDOFILE_NAME} or ${LANDOFILE_TS_NAME} found. Searched: ${searched.join(", ")}`,
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
): Effect.Effect<typeof LandofileShape.Type, LandofileValidationError> =>
  decodeOrFail(LandofileShape, (cause) => {
    const issues = validationIssues(cause);
    const { scope, remediation } = validationScope(parsed);
    return new LandofileValidationError({
      message: `Landofile contains ${scope}: ${issues.join(", ")}. ${remediation}`,
      file: filePath,
      issues,
    });
  })(parsed, { onExcessProperty: "error" });

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

const rejectBetaToolingFeatures = (
  filePath: string,
  parsed: unknown,
): Effect.Effect<unknown, NotImplementedError> => {
  const finding = scanToolingForBeta(parsed);
  if (finding === undefined) return Effect.succeed(parsed);
  return Effect.fail(
    new NotImplementedError({
      message: `${finding.description} in tooling task "${finding.task}" is not supported in Alpha Landofiles at ${filePath}.`,
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
  | NotImplementedError;

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

const discoverLandofile: Effect.Effect<typeof LandofileShape.Type, LandofileLoadError> = Effect.tryPromise({
  try: async () => findLandofile(process.cwd()),
  catch: (cause) => {
    if (cause instanceof LandofileNotFoundError) return cause;
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
  Effect.flatMap(({ filePath, form }) =>
    (form === "typescript" ? loadTsLandofile(filePath) : loadYamlLandofile(filePath)).pipe(
      Effect.flatMap((parsed) => validateLandofile(filePath, parsed)),
    ),
  ),
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
