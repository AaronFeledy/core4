import { ProviderId, ServiceName } from "@lando/sdk/schema";
import { DateTime } from "effect";

export const serviceName = ServiceName.make("web");
export const providerId = ProviderId.make("docker");
export const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-05-10T18:51:00Z"),
  source: "provider-docker.test",
  runtime: 4 as const,
};
