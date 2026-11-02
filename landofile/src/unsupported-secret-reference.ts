import { LandofileValidationError } from "@lando/sdk/errors";
import { executionSiteAt } from "@lando/sdk/landofile";
import {
  type LandofileLayer,
  LandofileLoadIssueRule,
  type ValidationFix,
  type ValidationIssuePath,
  formatValidationIssuePath,
} from "@lando/sdk/schema";
import { secretReferenceFix } from "./secret-reference-fix.ts";
import { SECRET_BINDING_SITES } from "./secret-reference.ts";
import { valueAtPath } from "./validation-suggestions.ts";

interface UnsupportedSecretReferenceInput {
  readonly source: {
    readonly file: string;
    readonly layer: LandofileLayer;
    readonly path: ValidationIssuePath;
  };
  readonly value: string;
  readonly references: readonly string[];
  readonly document?: unknown;
  readonly defaultServiceType?: string;
}

const usableName = (candidate: unknown): candidate is string =>
  typeof candidate === "string" &&
  /^[A-Za-z_][A-Za-z0-9_]*$/.test(candidate) &&
  candidate !== "LANDO" &&
  !candidate.startsWith("LANDO_");
const list = (values: readonly string[], type: "conjunction" | "disjunction" = "conjunction") =>
  new Intl.ListFormat("en", { type }).format(values);
const genericSuggestion = () =>
  `Use \${secret:...} only in ${list(
    SECRET_BINDING_SITES.map((site) => site.label.replaceAll("`", "")),
    "disjunction",
  )}. Write $\${secret:...} to keep the text literal.`;

export const unsupportedSecretReference = (
  input: UnsupportedSecretReferenceInput,
): {
  readonly message: string;
  readonly suggestion: string;
  readonly fix?: ValidationFix;
} => {
  const path = input.source.path;
  const match = executionSiteAt(path);
  const site = match?.site;
  const relative = match?.relativePath ?? [];
  const names = new Map<string, string>();
  const used = new Set<string>();
  for (const reference of new Set(input.references)) {
    const key =
      typeof path.at(-1) === "number" ? input.value.slice(0, input.value.indexOf("=")) : path.at(-1);
    const candidates = site === "build-arg" ? [key, reference] : [reference];
    let name = candidates.find(
      (candidate): candidate is string => usableName(candidate) && !used.has(candidate),
    );
    if (name === undefined) {
      let index = 1;
      while (used.has(index === 1 ? "SECRET" : `SECRET_${index}`)) index++;
      name = index === 1 ? "SECRET" : `SECRET_${index}`;
    }
    names.set(reference, name);
    used.add(name);
  }
  const environmentNames = [...names.values()];
  const name = list(environmentNames);
  const shell = list(environmentNames.map((name) => `$${name}`));
  const referenceLabel = names.size > 1 ? "references" : "reference";
  const binding = `\${secret:...} ${referenceLabel}`;
  const service = `services.${path[1]}`;
  const tooling = `tooling.${path[1]}`;
  const event = formatValidationIssuePath(["events", String(path[1]), Number(path[2])]);
  const bindings = (parent: string) => list(environmentNames.map((name) => `${parent}.${name}`));
  const afterStart = `For runtime use, set ${bindings(`${service}.environment`)} to the ${binding}. For setup that needs it, add an events.post-start step with service ${path[1]}, ${bindings("env")} set to the ${referenceLabel}, and ${shell} in its cmd; it runs in the started container.`;
  const authoredType = valueAtPath(input.document, ["services", String(path[1]), "type"]);
  const candidateType = authoredType === undefined ? input.defaultServiceType : authoredType;
  const type = typeof candidateType === "string" && !candidateType.includes("{{") ? candidateType : undefined;
  const guidance = ((): {
    readonly suggestion: string;
    readonly extra?: string;
    readonly bindingParent?: ValidationIssuePath;
    readonly shorthand?: boolean;
  } => {
    switch (site) {
      case undefined:
      case "secret-binding":
      case "tooling-var":
        return { suggestion: genericSuggestion() };
      case "build-arg":
        return { suggestion: afterStart, extra: " Build arguments can be recorded in image history." };
      case "build-dockerfile":
        return {
          suggestion: afterStart,
          extra: " Dockerfile instructions run before secrets resolve and can be recorded in image history.",
        };
      case "build-artifact":
      case "build-app": {
        const command =
          relative.length === 0 ||
          (relative.length === 1 && (relative[0] === "run" || typeof relative[0] === "number")) ||
          (relative.length === 2 && typeof relative[0] === "number" && relative[1] === "run");
        if (!command) return { suggestion: genericSuggestion() };
        if (site === "build-artifact")
          return {
            extra: " Image build steps run before secrets resolve and can be recorded in image history.",
            suggestion: `Move this step to ${service}.build.app, set ${bindings(`${service}.environment`)} to the ${binding}, and write ${shell} in the step.`,
          };
        return {
          bindingParent: ["services", String(path[1]), "environment"],
          suggestion: `Set ${bindings(`${service}.environment`)} to the ${binding} and write ${shell} in the step. The step's shell reads it from the container environment.`,
        };
      }
      case "tooling-task":
        return {
          suggestion: `Use the object form: set ${tooling}.cmd to this command with ${shell} in place of the ${referenceLabel}, and ${bindings(`${tooling}.env`)} to the ${binding}. The shell reads it when the task runs.`,
        };
      case "tooling-cmd":
      case "tooling-cmds": {
        const step = site === "tooling-cmds" && relative.length === 2 && relative[1] === "cmd";
        const command =
          site === "tooling-cmd" || (relative.length === 1 && typeof relative[0] === "number") || step;
        if (!command) return { suggestion: genericSuggestion() };
        const target = step
          ? formatValidationIssuePath(["tooling", String(path[1]), "cmds", Number(relative[0]), "env"])
          : `${tooling}.env`;
        if (site === "tooling-cmd" && relative.length > 0)
          return {
            suggestion: `Set ${bindings(target)} to the ${binding} and read ${name} from the environment in your program, or use a string cmd that reads ${shell}. Array commands run without a shell.`,
          };
        return {
          bindingParent: step
            ? ["tooling", String(path[1]), "cmds", Number(relative[0]), "env"]
            : ["tooling", String(path[1]), "env"],
          suggestion: `Set ${bindings(target)} to the ${binding} and write ${shell} in the command. The shell reads it when the ${step ? "step" : "task"} runs.`,
        };
      }
      case "event-step": {
        const shorthand = path.length === 3;
        return {
          bindingParent: ["events", String(path[1]), Number(path[2]), "env"],
          shorthand,
          suggestion: shorthand
            ? `Use the object form: set ${event}.cmd to this command with ${shell} in place of the ${referenceLabel}, and ${bindings(`${event}.env`)} to the ${binding}. The shell reads it when the step runs.`
            : `Set ${bindings(`${event}.env`)} to the ${binding} and write ${shell} in the step's ${path.at(-1) === "defer" ? "deferred command" : "cmd"}.`,
        };
      }
      case "event-lando-command":
        return {
          suggestion:
            "Lando command inputs cannot carry secrets. Move the work into a cmd step with the secret in that step's env.",
        };
      case "healthcheck":
        return {
          suggestion: `Set ${bindings(`${service}.environment`)} to the ${binding} and write ${shell} in a string healthcheck command. A list command runs without a shell, so the program must read ${name} from its environment.`,
        };
      case "service-command": {
        const compose =
          relative.length === 0
            ? `On type: compose, the string is split into arguments and is not a shell, so write sh -c with ${shell} inside one quoted argument.`
            : `On type: compose, a string command is split into arguments too, so write sh -c with ${shell} inside one quoted argument.`;
        const native =
          relative.length === 0
            ? `Write ${shell} in the command${typeof type === "string" ? ". The service type runs that string as a shell script." : " when the service type runs that string as a shell script."}`
            : `Array commands run without a shell, so read ${name} from the environment in your program, or use a string command that reads ${shell}.`;
        return {
          ...(relative.length === 0 && typeof type === "string" && type !== "compose"
            ? { bindingParent: ["services", String(path[1]), "environment"] }
            : {}),
          suggestion: `Set ${bindings(`${service}.environment`)} to the ${binding}. ${type === "compose" ? compose : typeof type === "string" ? native : `${native} ${compose}`}`,
        };
      }
      case "service-entrypoint": {
        const native = "A string entrypoint is one program name, not a shell.";
        const compose = `On type: compose it is split into arguments, so use sh -c with ${shell} inside one quoted argument when you need a shell.`;
        return {
          suggestion: `Set ${bindings(`${service}.environment`)} to the ${binding} and read ${name} from the environment in your program. ${type === "compose" ? compose : typeof type === "string" ? native : `${native} ${compose}`}`,
        };
      }
      default:
        return site satisfies never;
    }
  })();
  const fix =
    guidance.bindingParent === undefined
      ? undefined
      : secretReferenceFix({
          document: input.document,
          value: input.value,
          path,
          references: input.references,
          names,
          bindingParent: guidance.bindingParent,
          shorthand: guidance.shorthand ?? false,
        });
  return {
    message: `Secret references are not supported at ${formatValidationIssuePath(path)}.${guidance.extra ?? ""}`,
    suggestion: guidance.suggestion,
    ...(fix === undefined ? {} : { fix }),
  };
};

export const unsupportedSecretReferenceError = (
  input: UnsupportedSecretReferenceInput,
): LandofileValidationError => {
  const diagnostic = unsupportedSecretReference(input);
  return new LandofileValidationError({
    file: input.source.file,
    message: diagnostic.message,
    remediation: diagnostic.suggestion,
    issues: [
      {
        ...diagnostic,
        path: input.source.path,
        rule: LandofileLoadIssueRule.unsupportedSecretReference,
        source: input.source,
      },
    ],
  });
};
