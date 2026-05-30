import { describe, expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";

import { ServiceConfig } from "@lando/sdk/schema";

import { PLUGIN_NAME, globalServices, manifest, proxy } from "../src/index.ts";

describe("@lando/proxy-traefik plugin exports", () => {
  test("PLUGIN_NAME is the package name", () => {
    expect(PLUGIN_NAME).toBe("@lando/proxy-traefik");
  });

  test("proxy is a Layer", () => {
    expect(Layer.isLayer(proxy)).toBe(true);
  });

  test("manifest declares the traefik globalServices contribution", () => {
    expect(manifest.name).toBe("@lando/proxy-traefik");
    expect(manifest.api).toBe(4);
    const contributions = manifest.contributes?.globalServices ?? [];
    expect(contributions).toHaveLength(1);
    const traefik = contributions[0];
    expect(traefik?.id).toBe("traefik");
    expect(traefik?.module).toBe("./src/global-services/traefik.ts");
    expect(traefik?.enabledByDefault).toBe(true);
    expect(traefik?.requires?.providerCapabilities).toEqual(["sharedCrossAppNetwork"]);
    expect(traefik?.summary).toBe("Global Traefik reverse proxy");
  });

  test("manifest declares the traefik proxy contribution", () => {
    expect(manifest.contributes?.proxies).toEqual(["traefik"]);
  });

  test("globalServices map yields the traefik ServiceConfig effect", async () => {
    expect(globalServices).toBeInstanceOf(Map);
    const traefikEffect = globalServices.get("traefik");
    expect(traefikEffect).toBeDefined();
    if (traefikEffect === undefined) throw new Error("traefik effect missing");
    expect(Effect.isEffect(traefikEffect)).toBe(true);
    const config = Schema.decodeUnknownSync(ServiceConfig)(await Effect.runPromise(traefikEffect));
    expect(config.type).toBe("compose");
    expect(config.image).toBe("traefik:v3.3");
  });
});
