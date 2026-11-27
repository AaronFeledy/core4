import { posix, win32 } from "node:path";
import {
  HOST_PROXY_COMMAND_TARGETS,
  HOST_PROXY_CONTAINER_BRIDGE_SOCKET,
  HOST_PROXY_CONTAINER_DIR,
  HOST_PROXY_MOUNT_TARGETS,
  HOST_PROXY_TRANSPORT_EXTENSION_KEY,
} from "@lando/container-runtime/labels";
import { canonicalJson, sha256Hex } from "@lando/sdk/digest";
import { type AppPlan, PortablePath, type ServicePlan } from "@lando/sdk/schema";

import { HOST_PROXY_CONTAINER_DIRECTORY_NAME, HOST_PROXY_SOCKET_NAME } from "./run-directory.ts";
import { isHostProxyRunLandoEnvName } from "./session-env.ts";
import type { HostProxyRunLandoConnectionSession } from "./transport-protocol.ts";
import type { HostProxyTransportKind } from "./transport-session.ts";

export {
  HOST_PROXY_COMMAND_TARGETS,
  HOST_PROXY_CONTAINER_BRIDGE_SOCKET,
  HOST_PROXY_CONTAINER_LANDO,
  HOST_PROXY_MOUNT_TARGETS,
  HOST_PROXY_TRANSPORT_EXTENSION_KEY,
} from "@lando/container-runtime/labels";
export { HOST_PROXY_RUN_LANDO_ENV_NAMES, isHostProxyRunLandoEnvName } from "./session-env.ts";

/** Container path of a local host-proxy socket, inside the bound container-facing directory. */
export const HOST_PROXY_CONTAINER_SOCKET = `${HOST_PROXY_CONTAINER_DIR}/${HOST_PROXY_SOCKET_NAME}`;
/** Bump when the shape of what a container sees of host-proxy changes. */
const HOST_PROXY_CONTRACT_VERSION = 1;

export interface HostProxyRunLandoFeatureSession extends HostProxyRunLandoConnectionSession {
  readonly shimPath: string;
  readonly shimDigest?: string;
  /** Generation of the bound container-facing directory, so a recreated directory changes the contract. */
  readonly containerGeneration?: string;
  readonly transport?: HostProxyTransportKind;
  readonly containerUrl?: string;
}

interface HostProxyMount {
  readonly type: "bind";
  readonly origin: "integration";
  readonly source: string;
  readonly target: typeof PortablePath.Type;
  readonly readOnly: boolean;
  readonly realization: "passthrough";
}

interface HostProxyRunLandoFeatureMutators {
  addEnv(name: string, value: string): void;
  addExtension(name: string, value: { readonly contractDigest: string }): void;
  addMount(mount: HostProxyMount): void;
}

const pathFor = (path: string) => (/^[a-z]:[\\/]/iu.test(path) || path.startsWith("\\\\") ? win32 : posix);

const bind = (source: string, target: string): HostProxyMount => ({
  type: "bind",
  origin: "integration",
  source,
  target: PortablePath.make(target),
  readOnly: true,
  realization: "passthrough",
});

/**
 * Everything a container sees of one host-proxy session, and the digest of it that labels the
 * container. Credentials and a local socket arrive through a directory bind of the app's
 * container-facing host directory, which every session reuses, so a new session in the same
 * directory generation keeps the digest and running containers reach it without being
 * recreated; a directory recreated at the same path has a new generation and does not. A socket
 * bridged from a provider machine and a TCP host-gateway URL are per session, so they change it.
 */
export const hostProxyRunLandoContract = (session: HostProxyRunLandoFeatureSession) => {
  const transport = session.transport ?? "unix-socket";
  const path = pathFor(session.shimPath);
  const containerDir = path.join(path.dirname(session.shimPath), HOST_PROXY_CONTAINER_DIRECTORY_NAME);
  const env: Array<readonly [string, string]> = [["LANDO_HOST_PROXY_TRANSPORT", transport]];
  const mounts = [bind(containerDir, HOST_PROXY_CONTAINER_DIR)];
  if (transport === "tcp-host-gateway") {
    const containerUrl = session.containerUrl ?? session.url;
    if (containerUrl !== undefined) env.push(["LANDO_HOST_PROXY_URL", containerUrl]);
  } else if (session.socketPath === path.join(containerDir, HOST_PROXY_SOCKET_NAME)) {
    env.push(["LANDO_HOST_PROXY_SOCKET", HOST_PROXY_CONTAINER_SOCKET]);
  } else if (session.socketPath !== undefined) {
    mounts.push(bind(session.socketPath, HOST_PROXY_CONTAINER_BRIDGE_SOCKET));
    env.push(["LANDO_HOST_PROXY_SOCKET", HOST_PROXY_CONTAINER_BRIDGE_SOCKET]);
  }
  env.push(["LANDO_HOST_PROXY_DEPTH", "0"]);
  for (const target of HOST_PROXY_COMMAND_TARGETS) mounts.push(bind(session.shimPath, target));
  const contractDigest = sha256Hex(
    canonicalJson({
      version: HOST_PROXY_CONTRACT_VERSION,
      env: Object.fromEntries(env),
      mounts: mounts.map(({ source, target, readOnly }) => ({ source, target, readOnly })),
      ...(session.shimDigest === undefined ? {} : { shimDigest: session.shimDigest }),
      ...(session.containerGeneration === undefined
        ? {}
        : { containerGeneration: session.containerGeneration }),
    }),
  ).slice(0, 16);
  return { env, mounts, contractDigest };
};

export const hostProxyRunLandoFeature = (session: HostProxyRunLandoFeatureSession) => ({
  apply: (service: HostProxyRunLandoFeatureMutators): void => {
    const contract = hostProxyRunLandoContract(session);
    for (const [name, value] of contract.env) service.addEnv(name, value);
    for (const mount of contract.mounts) service.addMount(mount);
    service.addExtension(HOST_PROXY_TRANSPORT_EXTENSION_KEY, { contractDigest: contract.contractDigest });
  },
});

const stripHostProxyService = (service: ServicePlan): ServicePlan => ({
  ...service,
  environment: Object.fromEntries(
    Object.entries(service.environment).filter(([name]) => !isHostProxyRunLandoEnvName(name)),
  ),
  mounts: service.mounts.filter(
    (mount) =>
      !(
        HOST_PROXY_MOUNT_TARGETS.has(mount.target) &&
        (mount.origin === "integration" || (mount.origin === undefined && mount.type === "bind"))
      ),
  ),
  extensions: Object.fromEntries(
    Object.entries(service.extensions).filter(([name]) => name !== HOST_PROXY_TRANSPORT_EXTENSION_KEY),
  ),
});

/**
 * Pure inverse of the `hostProxyRunLandoFeature` overlay: removes the
 * session-scoped env, directory/socket/shim mounts, and transport extension so a plan
 * can be persisted or cached without live authentication material.
 */
export const stripHostProxyRunLando = (plan: AppPlan): AppPlan => ({
  ...plan,
  services: Object.fromEntries(
    Object.values(plan.services).map((service) => [service.name, stripHostProxyService(service)]),
  ),
});
