import type { HostProxyRunLandoRequest } from "@lando/sdk/schema";

import { filterHostProxyEnv as filterAllowedHostProxyEnv } from "../../config/agent-env.ts";

/**
 * Pure, Effect-free helpers for the in-container host-proxy shim.
 *
 * The shim itself is a tiny wire-protocol client with no Effect runtime; these
 * functions are the request-building logic it shares with the host-side test
 * dispatcher. They MUST stay side-effect-free.
 */

/**
 * Env keys the shim forwards to the host. Everything else is dropped so
 * container-leaked env (PATH, secrets, HOME, …) never poisons the host program.
 * The shared primitive also appends the agent-context allowlist so `runLando`
 * re-entry preserves agent markers.
 */
export const filterHostProxyEnv = (env: Readonly<Record<string, string>>): Record<string, string> =>
  filterAllowedHostProxyEnv(env);

export interface BuildRunLandoRequestInput {
  readonly argv: ReadonlyArray<string>;
  readonly cwd: string;
  readonly tty: boolean;
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Build the `runLando` wire request the in-container `lando` shim forwards: the
 * container argv, the container cwd (remapped host-side by the dispatcher), the
 * TTY flag, and env filtered to the shim allowlist. The `env` field is omitted
 * entirely when the filtered set is empty.
 */
export const buildRunLandoRequest = (input: BuildRunLandoRequestInput): HostProxyRunLandoRequest => {
  const filtered = input.env === undefined ? {} : filterHostProxyEnv(input.env);
  const hasEnv = Object.keys(filtered).length > 0;
  return {
    _tag: "runLando",
    argv: [...input.argv],
    cwd: input.cwd as HostProxyRunLandoRequest["cwd"],
    tty: input.tty,
    ...(hasEnv ? { env: filtered } : {}),
  };
};
