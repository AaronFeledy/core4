import type { HostTerminal } from "@lando/sdk/schema";

interface TerminalEnvOptions {
  readonly tty: boolean;
  readonly hostTerminal?: HostTerminal;
  readonly hostEnv?: Readonly<Record<string, string | undefined>>;
  readonly serviceEnv?: Readonly<Record<string, string>>;
  readonly env?: Readonly<Record<string, string>>;
}

export const withTerminalEnv = (options: TerminalEnvOptions): Record<string, string> | undefined => {
  if (!options.tty) return options.env === undefined ? undefined : { ...options.env };

  const terminalEnv: Record<string, string> = {
    COLUMNS: String(options.hostTerminal?.columns ?? (options.hostEnv?.COLUMNS || 80)),
    LINES: String(options.hostTerminal?.rows ?? (options.hostEnv?.LINES || 24)),
  };
  if (options.hostTerminal?.term !== undefined) terminalEnv.TERM = options.hostTerminal.term;
  if (options.hostTerminal?.colorterm !== undefined) terminalEnv.COLORTERM = options.hostTerminal.colorterm;
  for (const name of Object.keys(options.serviceEnv ?? {})) delete terminalEnv[name];

  const merged = { ...terminalEnv, ...(options.env ?? {}) };
  return Object.keys(merged).length === 0 ? undefined : merged;
};
