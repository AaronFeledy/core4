/**
 */
import { Effect } from "effect";

import { LandoCommandBase, type LandoCommandSpec } from "../../../command-base.ts";

export const appConfigTranslateSpec: LandoCommandSpec<never> = {
  id: "app:config:translate",
  summary: "Run config translators and optionally apply generated Landofile fragments.",
  namespace: "app",
  bootstrap: "app",
  run: () => Effect.die("not yet implemented: app:config:translate"),
};

export default class AppConfigTranslateCommand extends LandoCommandBase {
  static override description = appConfigTranslateSpec.summary;
  static override landoSpec: LandoCommandSpec = appConfigTranslateSpec;
  static override bootstrap = appConfigTranslateSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(appConfigTranslateSpec);
  }
}
