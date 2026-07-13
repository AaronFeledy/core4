import { normalizeScratchRunArgvForParsing } from "./commands/scratch-run.ts";

export { normalizeScratchRunArgvForParsing };

export const GLOBAL_COMMAND_VERBS = new Set([
  "config",
  "destroy",
  "info",
  "install",
  "list",
  "logs",
  "rebuild",
  "restart",
  "start",
  "status",
  "stop",
  "uninstall",
]);

export const GLOBAL_CONFIG_VERBS = new Set(["set", "unset", "edit", "validate"]);

export const RECIPES_COMMAND_VERBS = new Set(["list", "describe", "validate"]);

export const normalizeCompiledCommandArgv = (argv: ReadonlyArray<string>): ReadonlyArray<string> => {
  if (argv[0] === "apps" && argv[1] === "scratch" && argv[2] === "run") {
    return ["apps:scratch:run", ...argv.slice(3)];
  }

  if (argv[0] === "meta" && argv[1] === "recipes") {
    const verb = argv[2];
    if (verb === undefined || !RECIPES_COMMAND_VERBS.has(verb)) return argv;
    return [`meta:recipes:${verb}`, ...argv.slice(3)];
  }

  if (argv[0] === "meta" && argv[1] === "global") {
    const verb = argv[2];
    if (verb === undefined || !GLOBAL_COMMAND_VERBS.has(verb)) return argv;
    if (verb === "config") {
      const configVerb = argv[3];
      if (configVerb !== undefined && GLOBAL_CONFIG_VERBS.has(configVerb)) {
        return [`meta:global:config:${configVerb}`, ...argv.slice(4)];
      }
    }
    return [`meta:global:${verb}`, ...argv.slice(3)];
  }

  if (argv[0] === "global") {
    const verb = argv[1];
    if (verb === undefined || !GLOBAL_COMMAND_VERBS.has(verb)) return argv;
    if (verb === "config") {
      const configVerb = argv[2];
      if (configVerb !== undefined && GLOBAL_CONFIG_VERBS.has(configVerb)) {
        return [`global:config:${configVerb}`, ...argv.slice(3)];
      }
    }
    return [`global:${verb}`, ...argv.slice(2)];
  }

  if (argv[0] !== "app") return argv;
  if (argv[1] === "includes") {
    if (argv[2] === "update") return ["app:includes:update", ...argv.slice(3)];
    if (argv[2] === "verify") return ["app:includes:verify", ...argv.slice(3)];
    return argv;
  }
  if (argv[1] !== "config") return argv;
  if (argv[2] === "translate") return ["app:config:translate", ...argv.slice(3)];
  if (argv[2] === "lint") return ["app:config:lint", ...argv.slice(3)];
  if (argv[2] === "set") return ["app:config:set", ...argv.slice(3)];
  if (argv[2] === "unset") return ["app:config:unset", ...argv.slice(3)];
  if (argv[2] === "edit") return ["app:config:edit", ...argv.slice(3)];
  if (argv[2] === "validate") return ["app:config:validate", ...argv.slice(3)];
  return ["app:config", ...argv.slice(2)];
};

export const normalizeCompiledScratchRunArgvForUniversalFlags = (
  argv: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const head = argv[0];
  if (head !== "run" && head !== "scratch:run" && head !== "apps:scratch:run") return argv;
  return [head, ...normalizeScratchRunArgvForParsing(argv.slice(1))];
};
