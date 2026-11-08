import type { ServerResponse } from "node:http";
import type { Context, Fiber } from "effect";

import type { AppRef } from "@lando/sdk/schema";

import type { RedactionService } from "@lando/redaction/service";
import type { HostProxyMountInfo } from "./cwd-remap.ts";
import type { HostProxyOpenCallExecutor, HostProxyRunLandoExecutor } from "./dispatch.ts";
import type { HostProxyRunLandoSessionOptions } from "./transport-session.ts";
import type { HostProxyTransportKind } from "./transport.ts";
import type { HOST_PROXY_WORKER_PROTOCOL_VERSION } from "./worker-records.ts";

export interface HostProxyInFlightRequest {
  readonly fiber: Fiber.Fiber<void, never>;
  readonly response: ServerResponse;
  readonly releaseSlot: () => void;
}

export interface HandlerOptions {
  readonly app: AppRef;
  readonly mountInfo: HostProxyMountInfo;
  readonly allowlist: ReadonlyArray<string>;
  readonly callerService: string;
  readonly executor: HostProxyRunLandoExecutor;
  readonly openExecutor?: HostProxyOpenCallExecutor;
  readonly diagnostic?: HostProxyRunLandoSessionOptions["diagnostic"];
  readonly maxDepth: number;
  readonly concurrency: number;
  readonly bodyReadTimeoutMs: number;
  readonly slots: { count: number };
  readonly inFlight: Set<HostProxyInFlightRequest>;
  readonly session: {
    readonly appId: string;
    readonly sessionId: string;
    readonly token: string;
    readonly controlToken: string;
  };
  readonly control: {
    readonly token: string;
    readonly transport: HostProxyTransportKind;
    readonly protocolVersion: typeof HOST_PROXY_WORKER_PROTOCOL_VERSION;
    readonly configDigest: string;
    readonly providerId?: string;
    readonly configure?: (body: unknown) => Promise<void>;
    readonly pid: number;
    readonly bridgeState: () => "none" | "alive" | "dead";
    readonly shutdown: () => Promise<void>;
  };
  readonly runtimeContext: Context.Context<RedactionService>;
}
