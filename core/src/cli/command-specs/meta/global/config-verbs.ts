import { configRedactionTokens } from "../../../commands/config-redaction";
import { Args } from "../../../spec/metadata";

import {
  type GlobalConfigResult,
  GlobalConfigResultSchema,
  renderGlobalConfigResult,
} from "../../../commands/meta/global-config";
import { runGlobalConfig } from "../../../config-command-runtime.ts";
import type { LandoCommandSpec } from "../../../spec/command-base";
import { dryRunFlag, editorFlag, typeFlag } from "../../config-flags";
import { globalConfigFormatFromInput, globalConfigOptionsFromInput } from "./config";

const makeSpec = (
  subcommand: "set" | "unset" | "edit" | "validate",
  summary: string,
  metadata: Pick<LandoCommandSpec, "args" | "flags">,
): LandoCommandSpec<GlobalConfigResult> => ({
  resultSchema: GlobalConfigResultSchema,
  redactionTokens: configRedactionTokens,
  id: `meta:global:config:${subcommand}`,
  summary,
  description: summary,
  namespace: "meta",
  topLevelAlias: `global:config:${subcommand}`,
  bootstrap: "plugins",
  ...metadata,
  run: (input) => runGlobalConfig({ ...globalConfigOptionsFromInput(input), subcommand }),
  render: (result, input) => renderGlobalConfigResult(result, globalConfigFormatFromInput(input)),
});

export const metaGlobalConfigSetSpec = makeSpec("set", "Set a value in the global app's Landofile.", {
  args: {
    key: Args.string({ description: "Dot-path key.", required: true }),
    value: Args.string({ description: "Value to set.", required: true }),
  },
  flags: { type: typeFlag, "dry-run": dryRunFlag },
});

export const metaGlobalConfigUnsetSpec = makeSpec("unset", "Remove a key from the global app's Landofile.", {
  args: {
    key: Args.string({ description: "Dot-path key.", required: true }),
  },
  flags: { "dry-run": dryRunFlag },
});

export const metaGlobalConfigEditSpec = makeSpec("edit", "Edit the global app's Landofile in $EDITOR.", {
  flags: { editor: editorFlag, "dry-run": dryRunFlag },
});

export const metaGlobalConfigValidateSpec = makeSpec(
  "validate",
  "Validate the global app's Landofile against the schema.",
  {},
);
