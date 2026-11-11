import type { PodmanApiClient } from "@lando/provider-podman";
import { Effect } from "effect";

export const withPing = <T extends Omit<PodmanApiClient, "ping">>(api: T): PodmanApiClient => ({
  ping: Effect.void,
  ...api,
});
