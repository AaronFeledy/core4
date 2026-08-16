import { describe, expect, test } from "bun:test";

import {
  commonContainerLabels,
  containerCreateBodyFragment,
  containerHostConfigFragment,
  containerPortBindings,
  envArrayFromRecord,
  mountSuffix,
} from "@lando/container-runtime/plan";
import { type AppPlan, PortablePath, type ServicePlan } from "@lando/sdk/schema";

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
  healthcheck: {
    kind: "command",
    command: "curl --fail http://localhost:8080/health || exit 1",
    intervalSeconds: 30,
    timeoutSeconds: 5,
    retries: 3,
    startPeriodSeconds: 10,
  },
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
  extensions: {},
} as unknown as ServicePlan;

describe("container plan helpers", () => {
  test("converts env records and mount read-only suffixes", () => {
    expect(envArrayFromRecord({ FOO: "bar", BAZ: "qux" })).toEqual(["FOO=bar", "BAZ=qux"]);
    expect(mountSuffix(true)).toBe(":ro");
    expect(mountSuffix(false)).toBe("");
  });

  test("builds common labels and host config fragments", () => {
    const serviceWithLabels: ServicePlan = {
      ...service,
      extensions: {
        compose: {
          labels: {
            "example.com/role": "web",
            "dev.lando.app": "user-value",
            "skip-number": 42,
            "skip-null": null,
          },
        },
      },
    };

    expect(commonContainerLabels(plan, serviceWithLabels, { "dev.lando.scratch": "TRUE" })).toEqual({
      "example.com/role": "web",
      "dev.lando.app": "app-id",
      "dev.lando.service": "web",
      "dev.lando.scratch": "TRUE",
    });

    expect(containerHostConfigFragment(plan, service)).toEqual({
      PortBindings: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "38080" }] },
      Binds: ["/host/app:/app:ro", "/host/cache:/cache", "lando-cache-npm:/home/node/.npm"],
    });
  });

  test("emits option-bearing mounts as HostConfig Mounts without duplicate Binds", () => {
    const serviceWithMountOptions: ServicePlan = {
      ...service,
      appMount: undefined,
      mounts: [
        {
          type: "bind",
          source: "/host/existing",
          target: PortablePath.make("/existing"),
          readOnly: true,
          createHostPath: false,
          realization: "passthrough",
        },
        {
          type: "bind",
          source: "/host/synced",
          target: PortablePath.make("/synced"),
          readOnly: false,
          createHostPath: false,
          realization: "accelerated",
        },
        {
          type: "bind",
          source: "/host/ordinary",
          target: PortablePath.make("/ordinary"),
          readOnly: false,
          realization: "passthrough",
        },
      ],
      storage: [
        {
          store: "lando-data",
          target: PortablePath.make("/data"),
          readOnly: true,
          subpath: "tenant",
        },
        { store: "lando-cache", target: PortablePath.make("/cache"), readOnly: false },
      ],
    };

    const hostConfig = containerHostConfigFragment(plan, serviceWithMountOptions);

    expect(hostConfig).toEqual({
      PortBindings: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "38080" }] },
      Binds: ["myapp-web-mount-1:/synced", "/host/ordinary:/ordinary", "lando-cache:/cache"],
      Mounts: [
        {
          Type: "bind",
          Source: "/host/existing",
          Target: "/existing",
          ReadOnly: true,
          BindOptions: { CreateMountpoint: false },
        },
        {
          Type: "volume",
          Source: "lando-data",
          Target: "/data",
          ReadOnly: true,
          VolumeOptions: { Subpath: "tenant" },
        },
      ],
    });
  });

  test("omits an option-bearing bind that overlaps the app mount from Binds and Mounts", () => {
    const serviceWithOverlap: ServicePlan = {
      ...service,
      mounts: [
        {
          type: "bind",
          source: "/host/app",
          target: PortablePath.make("/app"),
          readOnly: true,
          createHostPath: false,
          realization: "passthrough",
        },
      ],
    };

    const hostConfig = containerHostConfigFragment(plan, serviceWithOverlap);

    expect(hostConfig).toEqual({
      PortBindings: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "38080" }] },
      Binds: ["/host/app:/app:ro", "lando-cache-npm:/home/node/.npm"],
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
      Healthcheck: {
        Test: ["CMD-SHELL", "curl --fail http://localhost:8080/health || exit 1"],
        Interval: 30_000_000_000,
        Timeout: 5_000_000_000,
        Retries: 3,
        StartPeriod: 10_000_000_000,
      },
      ExposedPorts: { "8080/tcp": {}, "9090/tcp": {} },
      Labels: { "dev.lando.app": "app-id", "dev.lando.service": "web" },
      HostConfig: {
        PortBindings: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "38080" }] },
        Binds: ["/host/app:/app:ro", "/host/cache:/cache", "lando-cache-npm:/home/node/.npm"],
      },
      NetworkingConfig: { EndpointsConfig: { "lando-myapp": {} } },
    });
  });

  test("uses preserved user labels in the default create body with Lando labels winning", () => {
    const serviceWithLabels: ServicePlan = {
      ...service,
      extensions: {
        compose: { labels: { "example.com/role": "web", "dev.lando.service": "user-value" } },
      },
    };

    expect(containerCreateBodyFragment(plan, serviceWithLabels)).toMatchObject({
      Labels: {
        "example.com/role": "web",
        "dev.lando.app": "app-id",
        "dev.lando.service": "web",
      },
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
