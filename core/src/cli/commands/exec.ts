/**
 * `lando exec` — run a command in a service.
 *
 * `ssh` is `exec` with default `--interactive --tty`. Bootstrap level: `app`.
 */
import type { Effect } from "effect";

import type { LandoCommandError } from "@lando/sdk/errors";

export interface ExecAppOptions {
  readonly service: string;
  readonly command: ReadonlyArray<string>;
  readonly interactive?: boolean;
  readonly tty?: boolean;
  readonly user?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface ExecAppResult {
  readonly exitCode: number;
}

export const execApp = (_options: ExecAppOptions): Effect.Effect<ExecAppResult, LandoCommandError, never> => {
  throw new Error("execApp: not yet implemented");
};
