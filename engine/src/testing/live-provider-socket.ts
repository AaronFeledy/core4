import { statSync } from "node:fs";

import { makeLandoPaths } from "@lando/paths";

export const LANDO_TEST_PODMAN_SOCKET_ENV = "LANDO_TEST_PODMAN_SOCKET";

export type LiveProviderSocketSource = "env" | "paths";

export interface LiveProviderSocket {
  readonly socketPath: string;
  readonly source: LiveProviderSocketSource;
}

const PROBE_SOCKET_PATH_ENV = "LANDO_LIVE_SOCKET_PROBE_PATH";
const PROBE_CONNECT_TIMEOUT_MS = 2_000;

/**
 * Evaluated by a short-lived child runtime. Exits 0 only when the endpoint
 * accepts a connection, so a socket inode left behind by a dead daemon exits
 * non-zero with `ECONNREFUSED`.
 */
const PROBE_SOURCE = `const socket = require("node:net").connect(process.env.${PROBE_SOCKET_PATH_ENV});
socket.setTimeout(${PROBE_CONNECT_TIMEOUT_MS});
socket.once("connect", () => { socket.destroy(); process.exit(0); });
socket.once("timeout", () => { socket.destroy(); process.exit(1); });
socket.once("error", () => process.exit(1));
`;

const isSocketOnDisk = (path: string): boolean => {
  try {
    return statSync(path).isSocket();
  } catch {
    return false;
  }
};

/**
 * Asks the endpoint whether it answers. A child runtime is what makes an
 * inherently asynchronous connect observable from a synchronous predicate;
 * `ProcessRunner` is deliberately not used because this helper must stay
 * Effect-free and callable at module scope from a `test.skipIf` gate.
 */
const socketAnswers = (path: string): boolean =>
  Bun.spawnSync({
    cmd: [process.execPath, "-e", PROBE_SOURCE],
    env: { ...process.env, [PROBE_SOCKET_PATH_ENV]: path },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  }).exitCode === 0;

/**
 * The cheap `stat` runs first so a host with no socket at all never pays for
 * a probe, and only a candidate that is actually a socket is connected to.
 */
const isLiveSocket = (path: string): boolean => isSocketOnDisk(path) && socketAnswers(path);

/**
 * Resolves the live provider socket from the rehearsal override or the
 * Lando-managed Paths default, requiring the candidate to answer a connection
 * rather than merely to exist. The override keeps its precedence but is not
 * exempt from that check: an override naming a dead socket is absent, so
 * resolution falls through to the equally checked managed candidate. Returns
 * `undefined` when neither candidate answers.
 */
export const resolveLiveProviderSocket = (): LiveProviderSocket | undefined => {
  const override = process.env[LANDO_TEST_PODMAN_SOCKET_ENV];
  if (override !== undefined && override.length > 0 && isLiveSocket(override)) {
    return { socketPath: override, source: "env" };
  }

  const managedSocketPath = makeLandoPaths().providerSocketPath;
  if (isLiveSocket(managedSocketPath)) {
    return { socketPath: managedSocketPath, source: "paths" };
  }

  return undefined;
};

/** Convenience predicate for `test.skipIf(!hasLiveProviderSocket())` gates. */
export const hasLiveProviderSocket = (): boolean => resolveLiveProviderSocket() !== undefined;
