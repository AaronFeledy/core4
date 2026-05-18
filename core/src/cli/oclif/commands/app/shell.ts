import { Flags } from "@oclif/core";

import { type ShellAppResult, renderShellAppResult, shellApp } from "../../../commands/shell.ts";
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../command-base.ts";

interface ShellFlags {
  readonly service?: string;
}

export const appShellSpec: LandoCommandSpec<ShellAppResult> = {
  id: "app:shell",
  summary: "Open a host shell scoped to the current Lando app.",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  run: () => shellApp(),
  render: (result) => renderShellAppResult(result as ShellAppResult),
};

export default class AppShellCommand extends LandoCommandBase {
  static override description = appShellSpec.summary;
  static override aliases = [...resolveTopLevelAliases(appShellSpec)];
  static override strict = false;
  static override flags = {
    service: Flags.string({
      char: "s",
      description: "(Beta) Open the shell inside a service via provider-exec; rejected in Alpha.",
    }),
  };
  static override landoSpec: LandoCommandSpec = appShellSpec;
  static override bootstrap = appShellSpec.bootstrap;

  override async run(): Promise<void> {
    const parsed = (await this.parse(AppShellCommand)) as { readonly flags: ShellFlags };
    await this.runEffect({
      ...appShellSpec,
      run: () =>
        shellApp({
          ...(parsed.flags.service === undefined ? {} : { service: parsed.flags.service }),
        }),
    });
  }
}
