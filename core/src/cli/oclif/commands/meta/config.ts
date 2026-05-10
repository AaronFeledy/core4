import { type ConfigResult, config } from "../../../commands/config.ts";
/**
 * `lando meta:config` — OCLIF wrapper.
 *
 * Reads or writes the global Lando config at `<userConfRoot>/config.yml`.
 * The bare `lando config` invocation is the default top-level alias for
 * this command (the app-scoped `app:config` does NOT register a top-level
 * alias).
 */
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../command-base.ts";

export const metaConfigSpec: LandoCommandSpec<ConfigResult> = {
  id: "meta:config",
  summary: "Read or write the global Lando config.",
  namespace: "meta",
  topLevelAlias: "config",
  bootstrap: "minimal",
  run: () => config(),
};

export default class MetaConfigCommand extends LandoCommandBase {
  static override description = metaConfigSpec.summary;
  static override aliases = [...resolveTopLevelAliases(metaConfigSpec)];
  static override landoSpec: LandoCommandSpec = metaConfigSpec;

  override async run(): Promise<void> {
    await this.runEffect(metaConfigSpec);
  }
}
