import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { ServiceConfig } from "@lando/sdk/schema";

import mailpitGlobalService from "../../src/global-services/mailpit.ts";
import {
  MAILPIT_DASHBOARD_HOSTNAME,
  MAILPIT_IMAGE,
  MAILPIT_SHARED_NETWORK_HOST,
  MAILPIT_SMTP_PORT,
  MAILPIT_WEB_PORT,
} from "../../src/mailpit-constants.ts";

const decodeConfig = async (): Promise<ServiceConfig> => {
  const value = await Effect.runPromise(mailpitGlobalService);
  return Schema.decodeUnknownSync(ServiceConfig)(value);
};

describe("mailpit global service ServiceConfig", () => {
  test("default export is an Effect producing a valid ServiceConfig", async () => {
    const config = await decodeConfig();
    expect(config.api).toBe(4);
    expect(config.type).toBe("compose");
  });

  test("uses a pinned Mailpit image", async () => {
    const config = await decodeConfig();
    expect(config.image).toBe(MAILPIT_IMAGE);
    expect(MAILPIT_IMAGE.startsWith("axllent/mailpit:v")).toBe(true);
  });

  test("opts out of the per-app source mount", async () => {
    const config = await decodeConfig();
    expect(config.appMount).toBe(false);
  });

  test("publishes the SMTP and web UI ports", async () => {
    const config = await decodeConfig();
    const ports = config.ports ?? [];
    expect(ports).toContain(String(MAILPIT_SMTP_PORT));
    expect(ports).toContain(String(MAILPIT_WEB_PORT));
    expect(MAILPIT_SMTP_PORT).toBe(1025);
    expect(MAILPIT_WEB_PORT).toBe(8025);
  });

  test("declares the shared SMTP network hostname", async () => {
    const config = await decodeConfig();
    expect(MAILPIT_SHARED_NETWORK_HOST).toBe("mailpit.global.internal");
    expect(config.hostnames).toContain(MAILPIT_SHARED_NETWORK_HOST);
  });

  test("routes the web UI through mailpit.lndo.site by default", async () => {
    const config = await decodeConfig();
    expect(MAILPIT_DASHBOARD_HOSTNAME).toBe("mailpit.lndo.site");
    const routes = config.routes ?? [];
    const webRoute = routes.find((route) => route.hostname === MAILPIT_DASHBOARD_HOSTNAME);
    expect(webRoute).toBeDefined();
    expect(webRoute?.endpoint).toBe(MAILPIT_WEB_PORT);
  });
});
