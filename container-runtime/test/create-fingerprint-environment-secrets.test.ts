import { expect, test } from "bun:test";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { DateTime } from "effect";
import { CREATE_CONFIG_LABEL } from "../src/create-fingerprint.ts";
import { commonContainerLabels } from "../src/plan.ts";

const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-10-22T00:00:00Z"),
  source: "test",
  runtime: 4 as const,
};
const service: ServicePlan = {
  name: ServiceName.make("web"),
  type: "web",
  provider: ProviderId.make("lando"),
  primary: true,
  artifact: { kind: "ref", ref: "nginx:latest" },
  environment: { TOKEN: "${secret:TEST}" },
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
};
const plan = (value: ServicePlan): AppPlan => ({
  id: AppId.make("fingerprint"),
  name: "fingerprint",
  slug: "fingerprint",
  root: AbsolutePath.make("/tmp/fingerprint"),
  provider: value.provider,
  services: { [value.name]: value },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
});
const fingerprint = (value: ServicePlan) => commonContainerLabels(plan(value), value)[CREATE_CONFIG_LABEL];

test("separates active and literal environment bytes in create identity", () => {
  // Given / When
  const literal = fingerprint(service);
  const active = fingerprint({
    ...service,
    environment: { TOKEN: { _tag: "SecretRef", reference: "TEST" } },
  });
  // Then
  expect(active).not.toBe(literal);
  expect(fingerprint(service)).toBe(literal);
});
