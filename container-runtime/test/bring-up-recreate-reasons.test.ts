import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";

import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";

import { bringUpRecreateReasons } from "../src/podman/bring-up-recreate.ts";

const providerId = ProviderId.make("lando");
const serviceName = ServiceName.make("web");
const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-09-01T00:00:00Z"),
  source: "container-runtime/bring-up-recreate-reasons.test.ts",
  runtime: 4 as const,
};

const service: ServicePlan = {
  name: serviceName,
  type: "web",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "nginx:1.27-alpine" },
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [
    {
      _tag: "published",
      port: 8080,
      protocol: "http",
      name: "http",
      publication: { bindAddress: "127.0.0.1", hostPort: 18080 },
    },
  ],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
};

const plan: AppPlan = {
  id: AppId.make("recreate-reasons"),
  name: "Recreate Reasons",
  slug: "recreate-reasons",
  root: AbsolutePath.make("/tmp/lando-recreate-reasons"),
  provider: providerId,
  services: { [service.name]: service },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

describe("bringUpRecreateReasons", () => {
  test("skipAbsentFields ignores drift when inspect snapshot fields are omitted", () => {
    expect(bringUpRecreateReasons(plan, service, {}, { skipAbsentFields: true })).toEqual([]);
  });

  test("reports publish-port, bind-source, and network drift when snapshot fields are present", () => {
    expect(
      bringUpRecreateReasons(
        plan,
        service,
        {
          publishFingerprint: "8080/tcp@127.0.0.1:18081",
          bindSources: { "/run/lando/ssh-agent": "bind:/tmp/old" },
          networkNames: ["unrelated"],
        },
        { skipAbsentFields: true },
      ),
    ).toEqual(["publish-port", "bind-source", "network"]);
  });

  test("does not recreate when only an app-mount bind source spelling changes", () => {
    const withAppMount = {
      ...service,
      mounts: [
        {
          type: "bind" as const,
          source: "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\embedded-app",
          target: "/app",
          readOnly: false,
          realization: "passthrough" as const,
        },
      ],
    };
    expect(
      bringUpRecreateReasons(
        { ...plan, services: { [service.name]: withAppMount } },
        withAppMount,
        {
          bindSources: {
            "/app": "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\embedded-app",
          },
        },
        { skipAbsentFields: true },
      ),
    ).toEqual([]);
  });
});
