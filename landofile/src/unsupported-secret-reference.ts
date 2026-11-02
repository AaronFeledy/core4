import { buildArgumentPath } from "./load-expression-shape.ts";
import { SECRET_BINDING_SITES } from "./secret-reference.ts";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const genericSuggestion = (): string =>
  `Use \${secret:...} only in ${new Intl.ListFormat("en", { type: "disjunction" }).format(
    SECRET_BINDING_SITES.map((site) => site.label.replaceAll("`", "")),
  )}. Write $\${secret:...} to keep the text literal.`;

// A build script is one step or a list of steps, and each step is a string or `{ run }`.
const buildStepPath = (path: readonly (string | number)[], kind: "app" | "artifact"): boolean => {
  if (path[0] !== "services" || path[2] !== "build" || path[3] !== kind) return false;
  const [step, field, ...rest] = path.slice(4);
  if (rest.length > 0) return false;
  if (step === undefined) return true;
  if (field === undefined) return step === "run" || typeof step === "number";
  return typeof step === "number" && field === "run";
};

export const unsupportedSecretReference = (
  path: readonly (string | number)[],
  reference: string,
  value: string,
): { readonly message: string; readonly suggestion: string } => {
  const buildArgument = buildArgumentPath(path);
  const listKey = value.includes("=") ? value.slice(0, value.indexOf("=")) : undefined;
  const name =
    [...(buildArgument ? [path[4], listKey] : []), reference].find(
      (candidate): candidate is string => typeof candidate === "string" && IDENTIFIER.test(candidate),
    ) ?? "SECRET";
  const service = `services.${path[1]}`;
  const tooling = `tooling.${path[1]}`;
  const shell = `$${name}`;
  const binding = "${secret:...} reference";
  const rules = [
    {
      matches: buildArgument,
      extra: " Build arguments can be recorded in image history.",
      suggestion: `For runtime use, set ${service}.environment.${name} to the ${binding}. For setup that needs it, add an events.post-start step with service ${path[1]}, env.${name} set to the reference, and ${shell} in its cmd; it runs in the started container.`,
    },
    {
      matches: buildStepPath(path, "artifact"),
      extra: " Image build steps run before secrets resolve and can be recorded in image history.",
      suggestion: `Move this step to ${service}.build.app, set ${service}.environment.${name} to the ${binding}, and write ${shell} in the step.`,
    },
    {
      matches: buildStepPath(path, "app"),
      suggestion: `Set ${service}.environment.${name} to the ${binding} and write ${shell} in the step. The step's shell reads it from the container environment.`,
    },
    {
      matches: path[0] === "tooling" && path.length === 2,
      suggestion: `Use the object form: set ${tooling}.cmd to this command with ${shell} in place of the reference, and ${tooling}.env.${name} to the ${binding}. The shell reads it when the task runs.`,
    },
    {
      matches:
        path[0] === "tooling" &&
        ((path[2] === "cmd" && path.length === 3) ||
          (path[2] === "cmds" &&
            typeof path[3] === "number" &&
            (path.length === 4 || (path.length === 5 && path[4] === "cmd")))),
      suggestion: `Set ${tooling}.env.${name} to the ${binding} and write ${shell} in the command. The shell reads it when the task runs.`,
    },
    {
      matches: path[0] === "tooling" && path[2] === "cmd" && typeof path[3] === "number" && path.length === 4,
      suggestion: `Set ${tooling}.env.${name} to the ${binding} and read ${name} from the environment in your program, or use a string cmd that reads ${shell}. Array commands run without a shell.`,
    },
    {
      matches: path[0] === "events" && typeof path[2] === "number" && path.length === 3,
      suggestion: `Use the object form: set events.${path[1]}.${path[2]}.cmd to this command with ${shell} in place of the reference, and events.${path[1]}.${path[2]}.env.${name} to the ${binding}. The shell reads it when the step runs.`,
    },
    {
      matches: path[0] === "events" && typeof path[2] === "number" && path.length === 4 && path[3] === "cmd",
      suggestion: `Set events.${path[1]}.${path[2]}.env.${name} to the ${binding} and write ${shell} in the step's cmd.`,
    },
    {
      matches: path[0] === "services" && path[2] === "command" && path.length === 3,
      suggestion: `Set ${service}.environment.${name} to the ${binding}. Write ${shell} in the command when the service type runs that string as a shell script. On type: compose, the string is split into arguments and is not a shell, so write sh -c with ${shell} inside one quoted argument.`,
    },
    {
      matches:
        path[0] === "services" && path[2] === "command" && typeof path[3] === "number" && path.length === 4,
      suggestion: `Set ${service}.environment.${name} to the ${binding} and read ${name} from the environment in your program, or use a string command that reads ${shell}. Array commands run without a shell.`,
    },
    {
      matches:
        path[0] === "services" &&
        path[2] === "entrypoint" &&
        (path.length === 3 || (path.length === 4 && typeof path[3] === "number")),
      suggestion: `Set ${service}.environment.${name} to the ${binding} and read ${name} from the environment in your program. A string entrypoint is one program name, not a shell. On type: compose it is split into arguments, so use sh -c with ${shell} inside one quoted argument when you need a shell.`,
    },
  ];
  const rule = rules.find((candidate) => candidate.matches);
  return {
    message: `Secret references are not supported at ${path.join(".")}.${rule?.extra ?? ""}`,
    suggestion: rule?.suggestion ?? genericSuggestion(),
  };
};
