import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Schema } from "effect";

import { ServiceConfig } from "@lando/sdk/schema";

import { PLUGIN_NAME, globalServices, manifest, proxy, routerServices } from "../src/index.ts";

describe("@lando/proxy-traefik plugin exports", () => {
  test("PLUGIN_NAME is the package name", () => {
    expect(PLUGIN_NAME).toBe("@lando/proxy-traefik");
  });

  test("proxy is a Layer", () => {
    expect(Layer.isLayer(proxy)).toBe(true);
  });

  test("manifest declares the Traefik and diagnostic globalServices contributions", () => {
    expect(String(manifest.name)).toBe("@lando/proxy-traefik");
    expect(manifest.api).toBe(4);
    const contributions = manifest.contributes?.globalServices ?? [];
    expect(contributions).toHaveLength(2);
    const traefik = contributions[0];
    expect(traefik?.id).toBe("traefik");
    expect(traefik?.module).toBe("./src/global-services/traefik.ts");
    expect(traefik?.enabledByDefault).toBe(true);
    expect(traefik?.requires?.providerCapabilities).toEqual(["sharedCrossAppNetwork"]);
    expect(traefik?.summary).toBe("Global Traefik router");
    expect(contributions[1]).toEqual({
      id: "traefik-diagnostics",
      module: "./src/global-services/diagnostics.ts",
      enabledByDefault: true,
      requires: { providerCapabilities: ["sharedCrossAppNetwork"] },
      summary: "Unmatched route diagnostics",
    });
  });

  test("manifest declares the traefik routerServices contribution", () => {
    expect(manifest.contributes?.routerServices).toEqual([
      {
        id: "traefik",
        module: "./src/proxy.ts",
        defaultFor: { platform: ["darwin", "linux", "win32"] },
      },
    ]);
    expect(routerServices.get("traefik")).toBe(proxy);
  });

  test("globalServices map yields the Traefik and diagnostic ServiceConfig effects", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-diagnostic-contribution-"));
    const previous = process.env.LANDO_USER_DATA_ROOT;
    process.env.LANDO_USER_DATA_ROOT = root;
    try {
      expect(globalServices).toBeInstanceOf(Map);
      const traefikEffect = globalServices.get("traefik");
      expect(traefikEffect).toBeDefined();
      if (traefikEffect === undefined) throw new Error("traefik effect missing");
      expect(Effect.isEffect(traefikEffect)).toBe(true);
      const config = Schema.decodeUnknownSync(ServiceConfig)(await Effect.runPromise(traefikEffect));
      expect(config.type).toBe("compose");
      expect(config.image).toBe("traefik:v3.3");

      const diagnosticsEffect = globalServices.get("traefik-diagnostics");
      expect(diagnosticsEffect).toBeDefined();
      if (diagnosticsEffect === undefined) throw new Error("diagnostics effect missing");
      const diagnostics = Schema.decodeUnknownSync(ServiceConfig)(await Effect.runPromise(diagnosticsEffect));
      expect(diagnostics).toMatchObject({
        type: "compose",
        image: "nginx:1.26-alpine",
        appMount: false,
        command: ["nginx", "-c", "/etc/lando/diagnostics/nginx.conf", "-g", "daemon off;"],
        hostnames: ["traefik-diagnostics.global.internal"],
        endpoints: [{ _tag: "internal", protocol: "http", port: 8080 }],
      });
      expect(diagnostics.mounts).toEqual([
        {
          type: "bind",
          source: "./proxy-traefik/diagnostic",
          target: "/etc/lando/diagnostics",
          readOnly: true,
        },
      ]);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
      else process.env.LANDO_USER_DATA_ROOT = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
});
