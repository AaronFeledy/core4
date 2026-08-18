import { Flags } from "../../spec/metadata";

import {
  type OpenAppResult,
  OpenAppResultSchema,
  openApp,
  openOptionsFromInput,
  renderOpenAppResult,
} from "../../commands/open";
import type { LandoCommandSpec } from "../../spec/command-base";

export const openSpec: LandoCommandSpec<OpenAppResult> = {
  resultSchema: OpenAppResultSchema,
  id: "app:open",
  summary: "Open a resolved app URL in the host browser.",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  hostProxyAllowed: true,
  flags: {
    service: Flags.string({ char: "s", description: "Scope resolution to a single service's routes." }),
    route: Flags.string({ description: "Select an exact route hostname to open." }),
    all: Flags.boolean({ description: "Open every resolved route." }),
    print: Flags.boolean({ description: "Print the resolved URL(s) instead of opening a browser." }),
  },
  run: (input) => openApp(openOptionsFromInput(input)),
  render: (result, _input, ctx) => renderOpenAppResult(result as OpenAppResult, ctx),
};
