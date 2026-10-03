import { Context, type Effect, type Scope } from "effect";

import type {
  TunnelAuthRequiredError,
  TunnelDetachedStateError,
  TunnelProviderUnavailableError,
  TunnelReadyTimeoutError,
  TunnelStartError,
  TunnelStopError,
  TunnelTargetUnresolvedError,
} from "../errors/index.ts";
import type {
  TunnelCapabilities,
  TunnelSession,
  TunnelSessionFilter,
  TunnelStartRequest,
  TunnelStatus,
  TunnelStatusRequest,
  TunnelStopRequest,
} from "../schema/index.ts";

export type TunnelError =
  | TunnelProviderUnavailableError
  | TunnelTargetUnresolvedError
  | TunnelAuthRequiredError
  | TunnelStartError
  | TunnelReadyTimeoutError
  | TunnelDetachedStateError
  | TunnelStopError;

export class TunnelService extends Context.Service<
  TunnelService,
  {
    readonly id: string;
    readonly capabilities: TunnelCapabilities;
    readonly start: (request: TunnelStartRequest) => Effect.Effect<TunnelSession, TunnelError, Scope.Scope>;
    readonly stop: (request: TunnelStopRequest) => Effect.Effect<void, TunnelError>;
    readonly status: (request: TunnelStatusRequest) => Effect.Effect<TunnelStatus, TunnelError>;
    readonly list: (filter?: TunnelSessionFilter) => Effect.Effect<ReadonlyArray<TunnelSession>, TunnelError>;
  }
>()("@lando/core/TunnelService") {}

export type TunnelServiceShape = TunnelService["Service"];
