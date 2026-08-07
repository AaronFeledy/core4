import type { ServerResponse } from "node:http";
import type { Context, Effect, Fiber } from "effect";

import type { AppRef } from "@lando/sdk/schema";
import type { EventService } from "@lando/sdk/services";

import type { RedactionService } from "../../redaction/service.ts";
import type { HostProxyMountInfo } from "./cwd-remap.ts";
import type { HostProxyRunLandoExecutor } from "./dispatch.ts";
import type { HostProxyTransportKind } from "./transport.ts";

export interface HostProxyInFlightRequest {
  readonly fiber: Fiber.RuntimeFiber<void, never>;
  readonly response: ServerResponse;
}

export interface HandlerOptions {
  readonly app: AppRef;
  readonly mountInfo: HostProxyMountInfo;
  readonly allowlist: ReadonlyArray<string>;
  readonly callerService: string;
  readonly executor: HostProxyRunLandoExecutor;
  readonly maxDepth: number;
  readonly concurrency: number;
  readonly bodyReadTimeoutMs: number;
  readonly semaphore: Effect.Semaphore;
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
    readonly protocolVersion: 1;
    readonly pid: number;
    readonly shutdown: () => Promise<void>;
  };
  readonly runtimeContext: Context.Context<EventService | RedactionService>;
}
