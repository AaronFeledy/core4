import {
  type OpenAppResult,
  OpenAppResultSchema,
  openApp,
  openOptionsFromInput,
  renderOpenAppResult,
} from "../../commands/open";
import { validateOpenSelection } from "../../commands/open-input";
import type { LandoCommandSpec } from "../../spec/command-base";
import { Args, Flags } from "../../spec/metadata";

export const openSpec: LandoCommandSpec<OpenAppResult> = {
  resultSchema: OpenAppResultSchema,
  id: "app:open",
  summary: "Open a resolved app URL in the host browser.",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  hostProxyAllowed: true,
  args: {
    hostname: Args.string({
      required: false,
      description: "Open this hostname through the route of this app that serves it, exact or wildcard.",
    }),
  },
  flags: {
    service: Flags.string({ char: "s", description: "Scope resolution to a single service's routes." }),
    all: Flags.boolean({
      description:
        "Open all eligible exact routes, or all eligible HTTP(S) publications if no route qualifies.",
    }),
    print: Flags.boolean({ description: "Print the resolved URL(s) instead of opening a browser." }),
    qr: Flags.boolean({ description: "Print the resolved URL(s) and a QR instead of opening a browser." }),
  },
  validateInput: (input) => validateOpenSelection(openOptionsFromInput(input)),
  run: (input) => openApp(openOptionsFromInput(input)),
  render: (result, input, ctx) => renderOpenAppResult(result, ctx, openOptionsFromInput(input)),
};
