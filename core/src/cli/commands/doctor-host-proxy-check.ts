import { Effect, Either } from "effect";

import type { HostProxyService } from "@lando/sdk/services";

import {
  type DoctorSubsystemCheck,
  HOST_PROXY_SPEC,
  buildDegradedCheck,
  passCheck,
} from "./doctor-subsystem-checks.ts";

export const buildHostProxyCheck = (
  hostProxy: typeof HostProxyService.Service,
  fix: boolean,
): Effect.Effect<DoctorSubsystemCheck, never> =>
  Effect.gen(function* () {
    const status = yield* Effect.either(hostProxy.status());
    if (
      Either.isRight(status) &&
      (status.right.active || (status.right.mode === "none" && status.right.mechanism === "skipped"))
    ) {
      const value = status.right;
      return passCheck(HOST_PROXY_SPEC, {
        subsystem: "host-proxy",
        subsystemId: hostProxy.id,
        active: String(value.active),
        mode: value.mode,
        mechanism: value.mechanism,
        baseDomain: value.baseDomain,
        loopback: value.loopback,
      });
    }
    const baseContext: Record<string, string> = Either.isRight(status)
      ? {
          subsystem: "host-proxy",
          subsystemId: hostProxy.id,
          active: String(status.right.active),
          mode: status.right.mode,
          mechanism: status.right.mechanism,
          baseDomain: status.right.baseDomain,
          loopback: status.right.loopback,
        }
      : {
          subsystem: "host-proxy",
          subsystemId: hostProxy.id,
          active: "false",
        };
    return yield* buildDegradedCheck(
      HOST_PROXY_SPEC,
      baseContext,
      fix,
      undefined,
      Either.isLeft(status) ? status.left : undefined,
    );
  });
