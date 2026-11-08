import { COMMAND_REGISTRY_MANIFEST } from "./generated/command-registry-manifest";

const compatibilityHeads = [
  ["scratch"],
  ["recipes"],
  ["share"],
  ["global"],
  ["meta", "recipes"],
  ["meta", "global"],
  ["apps", "scratch"],
  ["app", "config"],
  ["app", "includes"],
  ["app", "agent", "skills"],
  ["agent", "skills"],
] as const;

const commandIdsByToken: ReadonlyMap<string, string> = new Map(
  Object.values(COMMAND_REGISTRY_MANIFEST.commands).flatMap(({ spec, aliases }) =>
    [spec.id, ...aliases].map((token) => [token, spec.id] as const),
  ),
);

export const normalizeCompiledCommandArgv = (argv: ReadonlyArray<string>): ReadonlyArray<string> => {
  if (argv[0] === "app:config" && argv[1] === "describe") return ["app:config:describe", ...argv.slice(2)];
  if ((argv[0] === "global:config" || argv[0] === "meta:global:config") && argv[1] === "describe")
    return ["meta:global:config:describe", ...argv.slice(2)];
  if (argv[0] === "app:agent:skills" || argv[0] === "agent:skills") {
    const verb = argv[1];
    if (verb === "install" || verb === "update" || verb === "remove") {
      return [`app:agent:skills:${verb}`, ...argv.slice(2)];
    }
    return argv;
  }

  const head = compatibilityHeads.find((words) => words.every((word, index) => argv[index] === word));
  if (head === undefined) return argv;
  const flagIndex = argv.findIndex((token) => token.startsWith("-"));
  const end = flagIndex === -1 ? argv.length : flagIndex;
  for (let length = end; length > head.length; length--) {
    const token = argv.slice(0, length).join(":");
    const commandId = commandIdsByToken.get(token);
    if (commandId !== undefined) {
      // Preserve the existing short global spellings, except the describe projection.
      const outputId =
        argv[0] === "global" && commandId !== "meta:global:config:describe" ? token : commandId;
      return [outputId, ...argv.slice(length)];
    }
  }
  if (argv[0] === "app" && argv[1] === "config") return ["app:config", ...argv.slice(2)];
  return argv;
};
