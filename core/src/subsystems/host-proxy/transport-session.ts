import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import type { AppRef } from "@lando/sdk/schema";

import type { RootOverrides } from "../../config/paths.ts";
import { makeLandoPaths } from "../../config/paths.ts";
import type { HostProxyMountInfo } from "./cwd-remap.ts";
import type { HostProxyRunLandoExecutor } from "./dispatch.ts";
import { type HostProxyShimTarget, defaultHostProxyShimArtifactPath } from "./transport-shim.ts";

export const DEFAULT_CONCURRENCY = 16;
export const DEFAULT_MAX_DEPTH = 3;
export const DEFAULT_BODY_READ_TIMEOUT_MS = 30_000;

export type HostProxyTransportKind = "unix-socket" | "tcp-host-gateway";

export interface HostProxyRunLandoSessionOptions {
  readonly app: AppRef;
  readonly mountInfo: HostProxyMountInfo;
  readonly allowlist: ReadonlyArray<string>;
  readonly callerService: string;
  readonly executor: HostProxyRunLandoExecutor;
  readonly paths?: RootOverrides;
  readonly concurrency?: number;
  readonly maxDepth?: number;
  readonly bodyReadTimeoutMs?: number;
  readonly shimArtifactPath?: string;
  readonly shimTarget?: HostProxyShimTarget;
  readonly hostGatewayName?: string;
  readonly controlToken?: string;
}

export interface HostProxyRunLandoSession {
  readonly appId: string;
  readonly sessionId: string;
  readonly token: string;
  readonly controlToken: string;
  readonly socketPath?: string;
  readonly url?: string;
  readonly containerUrl?: string;
  readonly shimPath: string;
  readonly transport: HostProxyTransportKind;
  readonly close: () => Promise<void>;
  readonly closed: Promise<void>;
}

export interface HostProxySessionPaths {
  readonly stateDir: string;
  readonly socketPath?: string;
  readonly shimPath: string;
  readonly platform: string;
  readonly transport: HostProxyTransportKind;
}

export const makeHostProxyToken = (): string => randomBytes(32).toString("base64url");

export const hostProxyRunLandoStateDir = (
  app: Pick<AppRef, "id" | "root">,
  paths?: RootOverrides,
): string => {
  const landoPaths = makeLandoPaths(paths ?? {});
  return landoPaths.hostProxyRunDir(app.id, app.root);
};

export const sessionPaths = (options: HostProxyRunLandoSessionOptions): HostProxySessionPaths => {
  const paths = makeLandoPaths(options.paths ?? {});
  const stateDir = hostProxyRunLandoStateDir(options.app, options.paths);
  const transport: HostProxyTransportKind = paths.platform === "win32" ? "tcp-host-gateway" : "unix-socket";
  return {
    stateDir,
    ...(transport === "unix-socket" ? { socketPath: resolve(stateDir, "host-proxy.sock") } : {}),
    shimPath: resolve(stateDir, paths.platform === "win32" ? "lando.exe" : "lando"),
    platform: paths.platform,
    transport,
  };
};

export const resolveHostProxyShimArtifact = (options: HostProxyRunLandoSessionOptions): string | undefined =>
  options.shimArtifactPath ??
  (options.shimTarget === undefined
    ? undefined
    : defaultHostProxyShimArtifactPath({ target: options.shimTarget }));
