import { Effect, Either } from "effect";

import type { ProxyService } from "@lando/sdk/services";

import {
  type DoctorSubsystemCheck,
  PROXY_SPEC,
  buildDegradedCheck,
  isReadySubsystemId,
  passCheck,
} from "./doctor-subsystem-checks";

export const buildProxyCheck = (
  proxy: typeof ProxyService.Service,
  fix: boolean,
): Effect.Effect<DoctorSubsystemCheck, never> =>
  Effect.gen(function* () {
    const status = yield* Effect.either(proxy.status);
    const state = Either.isRight(status) ? status.right.state : undefined;
    const ready = isReadySubsystemId(proxy.id) && state === "running";
    const context: Record<string, string> = {
      subsystem: "proxy",
      subsystemId: proxy.id,
      ready: String(ready),
      ...(state === undefined ? {} : { state }),
    };
    if (ready) return passCheck(PROXY_SPEC, context);
    return yield* buildDegradedCheck(
      PROXY_SPEC,
      context,
      fix,
      () => Effect.scoped(proxy.setup({ defaultDomain: "lndo.site" })),
      Either.isLeft(status) ? status.left : undefined,
    );
  });
