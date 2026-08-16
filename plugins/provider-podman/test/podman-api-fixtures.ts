import { Effect } from "effect";

import type { PodmanApiClient } from "@lando/provider-podman";

export const withPing = <T extends Omit<PodmanApiClient, "ping">>(api: T): PodmanApiClient => ({
  ping: Effect.void,
  ...api,
});
