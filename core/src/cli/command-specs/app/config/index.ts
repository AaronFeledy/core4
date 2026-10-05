import { Args } from "../../../spec/metadata";

import {
  type AppConfigOptions,
  type AppConfigResult,
  AppConfigResultSchema,
  appConfig,
  appConfigRedactionTokens,
  renderAppConfigResult,
} from "../../../commands/app-config";
import type { LandoCommandSpec } from "../../../spec/command-base";
import { dryRunFlag, editorFlag, formatFlag, pathFlag, typeFlag } from "../../config-flags";
import { configWriteOptionsFromInput } from "../../config-write-input";

export const appConfigOptionsFromInput = (input: unknown): AppConfigOptions => {
  const opts = configWriteOptionsFromInput(input, { formats: ["json", "yaml", "table"] });
  return opts as AppConfigOptions;
};

export const appConfigSpec: LandoCommandSpec<AppConfigResult> = {
  resultSchema: AppConfigResultSchema,
  id: "app:config",
  resultFormats: ["table"],
  summary: "Read or write the current app's Landofile.",
  namespace: "app",
  topLevelAlias: false,
  bootstrap: "app",
  strict: false,
  args: {
    subcommand: Args.string({
      description: "Subcommand: view (default), set, unset, edit, validate.",
      required: false,
    }),
    key: Args.string({ description: "Dot-path key for set/unset.", required: false }),
    value: Args.string({ description: "Value for set.", required: false }),
  },
  flags: {
    format: formatFlag,
    type: typeFlag,
    path: pathFlag,
    editor: editorFlag,
    "dry-run": dryRunFlag,
  },
  run: (input) => appConfig(appConfigOptionsFromInput(input)),
  documentOutput: {
    format: "yaml",
    reason:
      "view emits a canonical bare Landofile that round-trips back into `.lando.yml`, so it is a product document rather than the result envelope in another shape. The get and write verbs carry no Landofile and use the envelope.",
    when: (input) => (appConfigOptionsFromInput(input).subcommand ?? "view") === "view",
  },
  redactionTokens: appConfigRedactionTokens,
  render: (result, input) => {
    const format = appConfigOptionsFromInput(input).format ?? "table";
    return renderAppConfigResult(result as AppConfigResult, format);
  },
};

export const appConfigMcpSpecs: ReadonlyArray<LandoCommandSpec<AppConfigResult>> = [
  {
    resultSchema: AppConfigResultSchema,
    id: "app:config:get",
    summary: "Read one resolved value from the current app's Landofile.",
    namespace: "app",
    bootstrap: "app",
    mcpAllowed: true,
    args: {
      key: { type: "string", required: true, description: "Dot-path key selector." },
    },
    run: (input) => appConfig({ ...appConfigOptionsFromInput(input), subcommand: "get" }),
    redactionTokens: appConfigRedactionTokens,
    render: (result, input) => {
      const format = appConfigOptionsFromInput(input).format ?? "table";
      return renderAppConfigResult(result as AppConfigResult, format);
    },
  },
  {
    resultSchema: AppConfigResultSchema,
    id: "app:config:view",
    summary: "Read the resolved config for the current app.",
    namespace: "app",
    bootstrap: "app",
    mcpAllowed: true,
    run: () => appConfig({ subcommand: "view" }),
    redactionTokens: appConfigRedactionTokens,
    render: (result, input) => {
      const format = appConfigOptionsFromInput(input).format ?? "table";
      return renderAppConfigResult(result as AppConfigResult, format);
    },
  },
];
