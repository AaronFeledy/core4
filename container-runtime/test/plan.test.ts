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
  endpoints: [{ port: 8080, protocol: "tcp" }],
  appMount: { source: "/host/app", target: "/app", readOnly: true, realization: "passthrough" },
  mounts: [
    { type: "bind", source: "/host/app", target: "/app", readOnly: true, realization: "passthrough" },
    { type: "bind", source: "/host/cache", target: "/cache", readOnly: false, realization: "passthrough" },
  ],
  storage: [{ store: "lando-cache-npm", target: "/home/node/.npm", readOnly: false }],
  hostAliases: [],
} as ServicePlan;

describe("container plan helpers", () => {
  test.each([
    {
      name: "explicit loopback HTTP published port",
      endpoint: { port: 80, protocol: "http", bind: "127.0.0.1", publishedPort: 38080 },
      expected: { "80/tcp": [{ HostIp: "127.0.0.1", HostPort: "38080" }] },
    },
    {
      name: "explicit loopback HTTPS published port",
      endpoint: { port: 443, protocol: "https", bind: "127.0.0.1", publishedPort: 38443 },
      expected: { "443/tcp": [{ HostIp: "127.0.0.1", HostPort: "38443" }] },
    },
    {
      name: "published port without bind",
      endpoint: { port: 5432, protocol: "tcp", publishedPort: 35432 },
      expected: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "35432" }] },
    },
    {
      name: "target-only fallback",
      endpoint: { port: 8080, protocol: "tcp" },
      expected: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "8080" }] },
    },
    {
      name: "UDP published port",
      endpoint: { port: 53, protocol: "udp", publishedPort: 38053 },
      expected: { "53/udp": [{ HostIp: "127.0.0.1", HostPort: "38053" }] },
    },
    {
      name: "explicit non-loopback bind",
      endpoint: { port: 3000, protocol: "tcp", bind: "0.0.0.0", publishedPort: 33000 },
      expected: { "3000/tcp": [{ HostIp: "0.0.0.0", HostPort: "33000" }] },
    },
  ] satisfies ReadonlyArray<{
    readonly name: string;
    readonly endpoint: ServicePlan["endpoints"][number];
    readonly expected: Readonly<Record<string, ReadonlyArray<Record<string, string>>>>;
  }>)("maps $name", ({ endpoint, expected }) => {
    expect(containerPortBindings({ ...service, endpoints: [endpoint] })).toEqual(expected);
  });

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
        PortBindings: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "8080" }] },
        Binds: ["/host/app:/app:ro", "/host/cache:/cache", "lando-cache-npm:/home/node/.npm"],
      },
      NetworkingConfig: { EndpointsConfig: { "lando-myapp": {} } },
    });
  });
});
