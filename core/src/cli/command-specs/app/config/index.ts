import type { Effect } from "effect";
import { specFlagsOf, stringFlag } from "../../../spec/input-coercion";
import { Args, Flags } from "../../../spec/metadata";

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
  const source = stringFlag(specFlagsOf(input), "source");
  return {
    ...opts,
    ...(["raw", "merged", "resolved"].includes(source ?? "") ? { source } : {}),
  } as AppConfigOptions;
};

const sourceFlag = Flags.string({
  description: "Inspect raw layers, authored composition, or resolved config.",
  options: ["raw", "merged", "resolved"],
});

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
    source: sourceFlag,
    editor: editorFlag,
    "dry-run": dryRunFlag,
  },
  run: (input) => appConfig(appConfigOptionsFromInput(input)),
  documentOutput: {
    format: "yaml",
    reason:
      "Only a full resolved view emits a canonical bare Landofile. Authored views, projections, get and writes use the normal result envelope.",
    when: (input) => {
      const options = appConfigOptionsFromInput(input);
      return (
        (options.subcommand ?? "view") === "view" &&
        (options.source ?? "resolved") === "resolved" &&
        options.path === undefined
      );
    },
  },
  redactionTokens: appConfigRedactionTokens,
  render: (result, input) => {
    const format = appConfigOptionsFromInput(input).format ?? "table";
    return renderAppConfigResult(result as AppConfigResult, format);
  },
};

export const appConfigMcpSpecs: ReadonlyArray<
  LandoCommandSpec<
    AppConfigResult,
    Effect.Error<ReturnType<typeof appConfig>>,
    Effect.Services<ReturnType<typeof appConfig>>
  >
> = [
  {
    resultSchema: AppConfigResultSchema,
    id: "app:config:get",
    summary: "Read one resolved value from the current app's Landofile.",
    namespace: "app",
    bootstrap: "app",
    mcpAllowed: true,
    args: {
      key: { type: "string", required: false, description: "Dot-path key selector; defaults to path." },
    },
    flags: { source: sourceFlag, path: pathFlag },
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
    flags: { source: sourceFlag, path: pathFlag },
    run: (input) => appConfig({ ...appConfigOptionsFromInput(input), subcommand: "view" }),
    redactionTokens: appConfigRedactionTokens,
    render: (result, input) => {
      const format = appConfigOptionsFromInput(input).format ?? "table";
      return renderAppConfigResult(result as AppConfigResult, format);
    },
  },
];
