import { COMMAND_TOPICS } from "./command-topics";
import {
  BUNDLED_COMMAND_DESCRIPTORS,
  BUNDLED_PLUGIN_MANIFESTS,
} from "./generated/bundled-command-descriptors";

export const pluginTopicRows = (
  commands: readonly { readonly id: string; readonly pluginName: string; readonly hidden?: boolean }[],
  manifests: readonly { readonly name: string; readonly description?: string }[],
): readonly { readonly token: string; readonly summary: string }[] =>
  [...new Set(commands.filter((command) => !command.hidden).map((command) => command.id.split(":")[0] ?? ""))]
    .filter((topic) => topic.length > 0 && !Object.hasOwn(COMMAND_TOPICS, topic) && topic !== "run")
    .toSorted()
    .map((topic) => {
      const owners = new Set(
        commands
          .filter((command) => !command.hidden && command.id.startsWith(`${topic}:`))
          .map((command) => command.pluginName),
      );
      const descriptions = manifests
        .filter((manifest) => owners.has(manifest.name))
        .map((manifest) => manifest.description);
      return {
        token: `lando help ${topic}`,
        summary:
          descriptions.length === 1 && descriptions[0]
            ? descriptions[0]
            : `Commands in the ${topic} plugin namespace.`,
      };
    });

const bundledPluginTopics = pluginTopicRows(BUNDLED_COMMAND_DESCRIPTORS, BUNDLED_PLUGIN_MANIFESTS);

export const moreRows = (pluginTopics = bundledPluginTopics) =>
  [
    { token: "lando help app", summary: "Config, remotes, share, includes" },
    { token: "lando help apps", summary: "Poweroff and scratch apps" },
    { token: "lando help plugin", summary: "Install and author plugins" },
    { token: "lando help global", summary: "Host-level global app" },
    { token: "lando help recipes", summary: "Bundled recipes" },
    ...pluginTopics,
    { token: "lando help --all", summary: "Every command and alias" },
    { token: "lando <command> --help", summary: "" },
  ] as const;

export const MORE_ROWS = moreRows();
