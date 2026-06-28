import { Flags } from "@oclif/core";

import { type ShellAppResult, renderShellAppResult, shellApp } from "../../../commands/shell.ts";
import {
  EmptyResultSchema,
  LandoCommandBase,
  type LandoCommandSpec,
  extractSpecAbortSignal,
  resolveTopLevelAliases,
} from "../../command-base.ts";

interface ShellFlags {
  readonly service?: string;
  readonly host?: boolean;
}

export const appShellSpec: LandoCommandSpec<ShellAppResult> = {
  resultSchema: EmptyResultSchema,
  id: "app:shell",
  summary: "Open an interactive shell in a Lando service.",
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
      description: "Service to open a shell in.",
    }),
    host: Flags.boolean({
      description: "Open a host shell scoped to the current app.",
    }),
  };
  static override landoSpec: LandoCommandSpec = appShellSpec;
  static override bootstrap = appShellSpec.bootstrap;

  override async run(): Promise<void> {
    const parsed = (await this.parse(AppShellCommand)) as { readonly flags: ShellFlags };
    await this.runEffect({
      ...appShellSpec,
      run: (input) => {
        const signal = extractSpecAbortSignal(input);
        return shellApp({
          host: parsed.flags.host === true,
          ...(signal === undefined ? {} : { signal }),
          ...(parsed.flags.service === undefined ? {} : { service: parsed.flags.service }),
          ...(parsed.flags.service !== undefined || parsed.flags.host === true || this.argv[0] === undefined
            ? {}
            : { service: this.argv[0] }),
        });
      },
    });
  }
}
