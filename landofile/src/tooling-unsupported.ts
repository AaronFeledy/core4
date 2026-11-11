import { NotImplementedError } from "@lando/sdk/errors";
import { isLandofileOverride } from "@lando/sdk/landofile";
import { formatValidationIssuePath } from "@lando/sdk/schema";
import { Effect, Predicate } from "effect";

export const UNSUPPORTED_REMEDIATION = "Remove the section; this surface is not supported.";

const UNSUPPORTED_TOOLING_TASK_KEYS = [
  "deps",
  "engine",
  "bootstrap",
  "dotenv",
  "appMount",
  "stdio",
  "interactive",
  "passThrough",
  "sources",
  "generates",
  "method",
  "status",
  "preconditions",
  "if",
  "run",
  "platforms",
  "prompt",
  "silent",
  "output",
  "failFast",
  "aliases",
  "topLevelAlias",
  "namespace",
  "internal",
  "hostProxyAllowed",
  "examples",
  "usage",
] as const;

/** Keys allowed on a cmds[] object step once `cmd` is present. */
const SUPPORTED_STEP_OBJECT_KEYS = new Set(["cmd", "service", "dir", "user", "env"]);

/** Dedicated step forms that remain unimplemented (rejected even without `cmd`). */
const UNSUPPORTED_STEP_OBJECT_KEYS = new Set(["task", "command", "defer", "for"]);

const SUPPORTED_FLAG_KEYS = new Set([
  "alias",
  "choices",
  "boolean",
  "default",
  "required",
  "description",
  "deprecated",
  "sensitive",
]);

const SUPPORTED_ARG_KEYS = new Set([
  "choices",
  "default",
  "required",
  "order",
  "description",
  "deprecated",
  "sensitive",
]);

/** A fragment may wrap any mapping in `!override`; the scan reads what it authors. */
const authored = (value: unknown): unknown => (isLandofileOverride(value) ? value.value : value);

interface ToolingUnsupportedFinding {
  readonly path: readonly (string | number)[];
  readonly description: string;
  readonly remediation?: string;
}

const scanEventsForUnsupported = function* (
  parsed: Readonly<Record<string, unknown>>,
): Generator<ToolingUnsupportedFinding> {
  const events = authored(parsed.events);
  if (!Predicate.isObject(events)) return;

  for (const [event, authoredSteps] of Object.entries(events as Record<string, unknown>)) {
    const steps = authored(authoredSteps);
    if (!Array.isArray(steps)) continue;
    for (const [index, authoredStep] of steps.entries()) {
      const step = authored(authoredStep);
      if (!Predicate.isObject(step)) continue;
      const structuredStep = step as Record<string, unknown>;
      if (Object.hasOwn(structuredStep, "platforms")) {
        yield {
          path: ["events", event, index, "platforms"],
          description: 'Event step field "platforms"',
        };
      }
    }
  }
};

const scanToolingInputMetadataForUnsupported = function* (
  taskName: string,
  task: Readonly<Record<string, unknown>>,
  section: "flags" | "args",
): Generator<ToolingUnsupportedFinding> {
  const metadata = authored(task[section]);
  if (metadata === undefined || !Predicate.isObject(metadata)) {
    return;
  }

  const allowedKeys = section === "flags" ? SUPPORTED_FLAG_KEYS : SUPPORTED_ARG_KEYS;

  for (const [name, entry] of Object.entries(metadata as Record<string, unknown>)) {
    const value = authored(entry);
    if (!Predicate.isObject(value)) continue;

    for (const unsupportedKey of Object.keys(value)) {
      if (allowedKeys.has(unsupportedKey)) continue;
      yield {
        path: ["tooling", taskName, section, name, unsupportedKey],
        description: `Tooling ${section} field "${unsupportedKey}"`,
      };
    }
  }
};

const scanCmdsStepForUnsupported = function* (
  taskName: string,
  stepIndex: number,
  stepObj: Readonly<Record<string, unknown>>,
): Generator<ToolingUnsupportedFinding> {
  let rejected = false;
  for (const stepKey of Object.keys(stepObj)) {
    if (UNSUPPORTED_STEP_OBJECT_KEYS.has(stepKey) || !SUPPORTED_STEP_OBJECT_KEYS.has(stepKey)) {
      rejected = true;
      yield {
        path: ["tooling", taskName, "cmds", stepIndex, stepKey],
        description: `Step-object cmds entry "${stepKey}"`,
      };
    }
  }

  if (!rejected && !Object.hasOwn(stepObj, "cmd")) {
    yield {
      path: ["tooling", taskName, "cmds", stepIndex],
      description: `Step-object cmds entry at index ${stepIndex} without "cmd"`,
    };
  }
};

const scanUnsupported = function* (parsed: unknown): Generator<ToolingUnsupportedFinding> {
  if (!Predicate.isObjectOrArray(parsed)) return;
  const parsedRecord = parsed as Record<string, unknown>;
  yield* scanEventsForUnsupported(parsedRecord);
  const tooling = authored(parsedRecord.tooling);
  if (!Predicate.isObject(tooling)) return;
  const toolingMap = tooling as Record<string, unknown>;

  for (const [taskName, authoredTask] of Object.entries(toolingMap)) {
    const taskValue = authored(authoredTask);
    if (!Predicate.isObject(taskValue)) continue;
    const task = taskValue as Record<string, unknown>;

    for (const key of UNSUPPORTED_TOOLING_TASK_KEYS) {
      if (Object.hasOwn(task, key)) {
        yield {
          path: ["tooling", taskName, key],
          description: `Tooling task field "${key}"`,
        };
      }
    }

    yield* scanToolingInputMetadataForUnsupported(taskName, task, "flags");
    yield* scanToolingInputMetadataForUnsupported(taskName, task, "args");

    const cmds = authored(task.cmds);
    if (Array.isArray(cmds)) {
      for (let stepIndex = 0; stepIndex < cmds.length; stepIndex++) {
        const step = authored(cmds[stepIndex]);
        if (Predicate.isObject(step)) {
          yield* scanCmdsStepForUnsupported(taskName, stepIndex, step as Record<string, unknown>);
        }
      }
    }

    const vars = authored(task.vars);
    if (Predicate.isObject(vars)) {
      for (const [varName, authoredVar] of Object.entries(vars as Record<string, unknown>)) {
        const varValue = authored(authoredVar);
        if (Predicate.isObject(varValue)) {
          for (const form of ["default", "prompt"] as const) {
            if (Object.hasOwn(varValue, form))
              yield {
                path: ["tooling", taskName, "vars", varName, form],
                description: `Tooling var form "${form}:" in tooling var "${varName}"`,
                remediation:
                  form === "default"
                    ? `Write the value directly: vars.${varName}: <value>.`
                    : `Declare a flag or arg, or compute the value with vars.${varName}.sh.`,
              };
          }
          if (Object.hasOwn(varValue, "raw")) {
            yield {
              path: ["tooling", taskName, "vars", varName, "raw"],
              description: `Unsafe "raw:" interpolation in tooling var "${varName}"`,
            };
          }
        }
      }
    }
  }
};

export const scanToolingForUnsupported = (parsed: unknown) => Array.from(scanUnsupported(parsed));

export const unsupportedToolingMessage = (finding: ReturnType<typeof scanToolingForUnsupported>[number]) =>
  `${finding.description} at ${formatValidationIssuePath(finding.path)} is not supported.`;

export const rejectUnsupportedToolingFeatures = (
  filePath: string,
  parsed: unknown,
): Effect.Effect<unknown, NotImplementedError> => {
  const finding = scanToolingForUnsupported(parsed)[0];
  if (finding === undefined) return Effect.succeed(parsed);
  return Effect.fail(
    new NotImplementedError({
      message: `${unsupportedToolingMessage(finding)} Source: ${filePath}.`,
      commandId: "landofile.parse",
      remediation: finding.remediation ?? UNSUPPORTED_REMEDIATION,
    }),
  );
};
