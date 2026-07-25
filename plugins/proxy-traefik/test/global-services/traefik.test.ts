import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { ServiceConfig } from "@lando/sdk/schema";

import traefikGlobalService, {
  TRAEFIK_DASHBOARD_HOSTNAME,
  TRAEFIK_DYNAMIC_CONFIG_DIR,
  TRAEFIK_IMAGE,
} from "../../src/global-services/traefik.ts";

const decodeConfig = async (): Promise<ServiceConfig> => {
  const value = await Effect.runPromise(traefikGlobalService);
  return Schema.decodeUnknownSync(ServiceConfig)(value);
};

const commandText = (config: ServiceConfig): string =>
  Array.isArray(config.command) ? config.command.join("\n") : (config.command ?? "");

describe("traefik global service ServiceConfig", () => {
  test("default export is an Effect producing a valid ServiceConfig", async () => {
    const config = await decodeConfig();
    expect(config.api).toBe(4);
    expect(config.type).toBe("compose");
  });

  test("uses a pinned Traefik v3 image", async () => {
    const config = await decodeConfig();
    expect(config.image).toBe(TRAEFIK_IMAGE);
    expect(TRAEFIK_IMAGE.startsWith("traefik:v3")).toBe(true);
  });

  test("opts out of the per-app source mount", async () => {
    const config = await decodeConfig();
    expect(config.appMount).toBe(false);
  });

  test("publishes rootless-safe loopback ingress endpoints", async () => {
    const config = await decodeConfig();
    expect(config.endpoints).toEqual([
      {
        _tag: "published",
        name: "web",
        protocol: "http",
        port: 80,
        publication: { bindAddress: "127.0.0.1", hostPort: 38080 },
      },
      {
        _tag: "published",
        name: "websecure",
        protocol: "https",
        port: 443,
        publication: { bindAddress: "127.0.0.1", hostPort: 38443 },
      },
    ]);
    expect(config.ports).toEqual(["8080"]);
  });

  test("mounts the durable route configuration into the file provider directory", async () => {
    const config = await decodeConfig();
    expect(config.mounts).toEqual([
      {
        type: "bind",
        source: "./proxy-traefik/dynamic",
        target: TRAEFIK_DYNAMIC_CONFIG_DIR,
        readOnly: false,
      },
    ]);
  });

  test("enables the file provider and dashboard via static flags", async () => {
    const config = await decodeConfig();
    const text = commandText(config);
    expect(text).toContain(`--providers.file.directory=${TRAEFIK_DYNAMIC_CONFIG_DIR}`);
    expect(text).toContain("--providers.file.watch=true");
    expect(text).toContain("--api.dashboard=true");
    expect(text).toContain("--entrypoints.web.address=:80");
    expect(text).toContain("--entrypoints.websecure.address=:443");
    expect(text).toContain("--entrypoints.traefik.address=:8080");
    // Routing must NOT depend on the provider-specific Docker provider.
    expect(text).not.toContain("--providers.docker");
  });

  test("routes the dashboard through the file provider on traefik.lndo.site → api@internal", async () => {
    const config = await decodeConfig();
    const text = commandText(config);
    expect(TRAEFIK_DASHBOARD_HOSTNAME).toBe("traefik.lndo.site");
    expect(text).toContain("Host(`traefik.lndo.site`)");
    expect(text).toContain("api@internal");
    // The router is materialized into the dynamic config directory at start.
    expect(text).toContain(TRAEFIK_DYNAMIC_CONFIG_DIR);
    expect(text).toContain("exec traefik");
  });
});
