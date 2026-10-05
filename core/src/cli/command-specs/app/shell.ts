import { Flags } from "../../spec/metadata";

import { type ShellAppResult, renderShellAppResult, shellApp } from "../../commands/shell";
import { EmptyResultSchema, type LandoCommandSpec, extractSpecAbortSignal } from "../../spec/command-base";
import { booleanFlag, specFlagsOf, stringFlag } from "../../spec/input-coercion";

export const appShellSpec: LandoCommandSpec<ShellAppResult> = {
  resultSchema: EmptyResultSchema,
  id: "app:shell",
  summary: "Open an interactive host shell for the current app, or a service shell with --service.",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  strict: true,
  usage: "[--service SERVICE]",
  flags: {
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
  },
  run: (input) => {
    const flags = specFlagsOf(input);
    const service = stringFlag(flags, "service");
    const signal = extractSpecAbortSignal(input);
    return shellApp({
      host: booleanFlag(flags, "host"),
      noHistory: booleanFlag(flags, "no-history"),
      noInteractive: booleanFlag(flags, "no-interactive"),
      ...(signal === undefined ? {} : { signal }),
      ...(service === undefined ? {} : { service }),
    });
  },
  successExitCode: (result) => result.exitCode,
  render: (result) => renderShellAppResult(result as ShellAppResult),
};
