import { describe, expect, test } from "bun:test";

import {
  commonContainerLabels,
  containerCreateBodyFragment,
  containerHostConfigFragment,
  containerPortBindings,
  envArrayFromRecord,
  mountSuffix,
} from "@lando/container-runtime/plan";
import type { AppPlan, ServicePlan } from "@lando/sdk/schema";

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
  endpoints: [
    {
      _tag: "published",
      port: 8080,
      protocol: "tcp",
      publication: { bindAddress: "127.0.0.1", hostPort: 38080 },
    },
    { _tag: "internal", port: 9090, protocol: "tcp" },
  ],
  appMount: { source: "/host/app", target: "/app", readOnly: true, realization: "passthrough" },
  mounts: [
    { type: "bind", source: "/host/app", target: "/app", readOnly: true, realization: "passthrough" },
    { type: "bind", source: "/host/cache", target: "/cache", readOnly: false, realization: "passthrough" },
  ],
  storage: [{ store: "lando-cache-npm", target: "/home/node/.npm", readOnly: false }],
  hostAliases: [],
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
      PortBindings: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "38080" }] },
      Binds: ["/host/app:/app:ro", "/host/cache:/cache", "lando-cache-npm:/home/node/.npm"],
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
        PortBindings: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "38080" }] },
        Binds: ["/host/app:/app:ro", "/host/cache:/cache", "lando-cache-npm:/home/node/.npm"],
      },
      NetworkingConfig: { EndpointsConfig: { "lando-myapp": {} } },
    });
  });

  test("groups multiple host bindings for the same container port", () => {
    expect(
      containerPortBindings([
        {
          _tag: "published",
          port: 8080,
          protocol: "tcp",
          publication: { bindAddress: "127.0.0.1", hostPort: 38080 },
        },
        {
          _tag: "published",
          port: 8080,
          protocol: "tcp",
          publication: { bindAddress: "0.0.0.0", hostPort: 48080 },
        },
      ]),
    ).toEqual({
      "8080/tcp": [
        { HostIp: "127.0.0.1", HostPort: "38080" },
        { HostIp: "0.0.0.0", HostPort: "48080" },
      ],
    });
  });
});
