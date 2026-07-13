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
  readonly "no-history"?: boolean;
  readonly "no-interactive"?: boolean;
}

export const appShellSpec: LandoCommandSpec<ShellAppResult> = {
  resultSchema: EmptyResultSchema,
  id: "app:shell",
  summary: "Open an interactive host shell for the current app, or a service shell with --service.",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  run: () => shellApp(),
  render: (result) => renderShellAppResult(result as ShellAppResult),
};

export default class AppShellCommand extends LandoCommandBase {
  static override description = appShellSpec.summary;
  static override aliases = [...resolveTopLevelAliases(appShellSpec)];
  static override flags = {
    service: Flags.string({
      char: "s",
      description: "Open a shell inside this service instead of on the host.",
    }),
    host: Flags.boolean({
      description: "Deprecated: host is the default; --host is redundant.",
    }),
    "no-history": Flags.boolean({
      description: "Do not persist host shell history for this session.",
    }),
    "no-interactive": Flags.boolean({
      description: "Reject interactive shell startup (use app:exec for automation).",
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
          noHistory: parsed.flags["no-history"] === true,
          noInteractive: parsed.flags["no-interactive"] === true,
          ...(signal === undefined ? {} : { signal }),
          ...(parsed.flags.service === undefined ? {} : { service: parsed.flags.service }),
        });
      },
    });
  }
}
