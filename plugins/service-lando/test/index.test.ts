import { Effect, Layer, Schema } from "effect";

import { ServiceConfig } from "@lando/sdk/schema";

import { PLUGIN_NAME, globalServices, manifest, serviceTypes, services } from "../src/index.ts";
import { MAILPIT_IMAGE } from "../src/mailpit-constants.ts";

describe("@lando/service-lando plugin exports", () => {
  test("PLUGIN_NAME is the package name", () => {
    expect(PLUGIN_NAME).toBe("@lando/service-lando");
  });

  test("services is a Layer", () => {
    expect(Layer.isLayer(services)).toBe(true);
  });

  test("manifest declares the mailpit globalServices contribution", () => {
    expect(manifest.name).toBe("@lando/service-lando");
    expect(manifest.api).toBe(4);
    const contributions = manifest.contributes?.globalServices ?? [];
    expect(contributions).toHaveLength(1);
    const mailpit = contributions[0];
    expect(mailpit?.id).toBe("mailpit");
    expect(mailpit?.module).toBe("./src/global-services/mailpit.ts");
    expect(mailpit?.enabledByDefault).toBe(true);
    expect(mailpit?.requires?.providerCapabilities).toEqual(["sharedCrossAppNetwork"]);
    expect(mailpit?.summary).toBe("Global Mailpit SMTP capture server with web UI");
  });

  test("manifest declares the existing service type contributions", () => {
    expect(manifest.contributes?.serviceTypes).toHaveLength(serviceTypes.size);
    expect(manifest.contributes?.serviceTypes).toContain("node:lts");
    expect(manifest.contributes?.serviceTypes).toContain("postgres");
  });

  test("globalServices map yields the mailpit ServiceConfig effect", async () => {
    expect(globalServices).toBeInstanceOf(Map);
    const mailpitEffect = globalServices.get("mailpit");
    expect(mailpitEffect).toBeDefined();
    if (mailpitEffect === undefined) throw new Error("mailpit effect missing");
    expect(Effect.isEffect(mailpitEffect)).toBe(true);
    const config = Schema.decodeUnknownSync(ServiceConfig)(await Effect.runPromise(mailpitEffect));
    expect(config.type).toBe("compose");
    expect(config.image).toBe(MAILPIT_IMAGE);
  });
});
