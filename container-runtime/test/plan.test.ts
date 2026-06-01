import { describe, expect, test } from "bun:test";

import type { AppPlan, ServicePlan } from "@lando/sdk/schema";
import {
  commonContainerLabels,
  containerCreateBodyFragment,
  containerHostConfigFragment,
  envArrayFromRecord,
  mountSuffix,
} from "@lando/container-runtime/plan";

const plan = {
  id: "app-id",
  name: "myapp",
  slug: "myapp",
  extensions: {},
} as AppPlan;

const service = {
  name: "web",
  environment: { FOO: "bar", BAZ: "qux" },
  artifact: { kind: "ref", ref: "nginx:latest" },
  command: "echo hi",
  entrypoint: "docker-entrypoint.sh",
  workingDirectory: "/app",
  endpoints: [{ port: 8080, protocol: "tcp" }],
  appMount: { source: "/host/app", target: "/app", readOnly: true, realization: "passthrough" },
  mounts: [
    { type: "bind", source: "/host/app", target: "/app", readOnly: true, realization: "passthrough" },
    { type: "bind", source: "/host/cache", target: "/cache", readOnly: false, realization: "passthrough" },
  ],
} as unknown as ServicePlan;

describe("container plan helpers", () => {
  test("converts env records and mount read-only suffixes", () => {
    expect(envArrayFromRecord({ FOO: "bar", BAZ: "qux" })).toEqual(["FOO=bar", "BAZ=qux"]);
    expect(mountSuffix(true)).toBe(":ro");
    expect(mountSuffix(false)).toBe("");
  });

  test("builds common labels and host config fragments", () => {
    expect(commonContainerLabels(plan, service, { "dev.lando.scratch": "TRUE" })).toEqual({
      "dev.lando.app": "app-id",
      "dev.lando.service": "web",
      "dev.lando.scratch": "TRUE",
    });

    expect(containerHostConfigFragment(plan, service)).toEqual({
      PortBindings: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "8080" }] },
      Binds: ["/host/app:/app:ro", "/host/cache:/cache"],
    });
  });

  test("builds common create body fields from a ref artifact", () => {
    expect(
      containerCreateBodyFragment(plan, service, {
        labels: commonContainerLabels(plan, service),
        hostConfig: containerHostConfigFragment(plan, service),
        networkingConfig: { EndpointsConfig: { "lando-myapp": {} } },
      }),
    ).toEqual({
      Image: "nginx:latest",
      Env: ["FOO=bar", "BAZ=qux"],
      Cmd: ["sh", "-lc", "echo hi"],
      Entrypoint: ["docker-entrypoint.sh"],
      WorkingDir: "/app",
      Labels: { "dev.lando.app": "app-id", "dev.lando.service": "web" },
      HostConfig: {
        PortBindings: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "8080" }] },
        Binds: ["/host/app:/app:ro", "/host/cache:/cache"],
      },
      NetworkingConfig: { EndpointsConfig: { "lando-myapp": {} } },
    });
  });
});
