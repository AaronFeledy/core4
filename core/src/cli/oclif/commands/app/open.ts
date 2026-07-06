import { Flags } from "@oclif/core";

import {
  type OpenAppResult,
  OpenAppResultSchema,
  openApp,
  openOptionsFromInput,
  renderOpenAppResult,
} from "../../../commands/open.ts";
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../command-base.ts";

export const openSpec: LandoCommandSpec<OpenAppResult> = {
  resultSchema: OpenAppResultSchema,
  id: "app:open",
  summary: "Open a resolved app URL in the host browser.",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  hostProxyAllowed: true,
  run: (input) => openApp(openOptionsFromInput(input)),
  render: (result, _input, ctx) => renderOpenAppResult(result as OpenAppResult, ctx),
};

export default class OpenCommand extends LandoCommandBase {
  static override description = openSpec.summary;
  static override aliases = [...resolveTopLevelAliases(openSpec)];
  static override flags = {
    service: Flags.string({ char: "s", description: "Scope resolution to a single service's routes." }),
    route: Flags.string({ description: "Select an exact route hostname to open." }),
    all: Flags.boolean({ description: "Open every resolved route." }),
    print: Flags.boolean({ description: "Print the resolved URL(s) instead of opening a browser." }),
  };
  static override landoSpec: LandoCommandSpec = openSpec;
  static override bootstrap = openSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(openSpec);
  }
}
