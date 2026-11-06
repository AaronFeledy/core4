import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { AppId } from "@lando/sdk/schema";

import { renderRouteFileMetadata } from "../src/route-file-metadata.ts";
import { persistedStatus } from "../src/status.ts";
import { makeHarness } from "./proxy-tls-harness.ts";

const ownerKey = "ef".repeat(32);
const directory = "/lando/global/proxy-traefik/dynamic";

describe("persistedStatus configuredApps from owner-layout metadata", () => {
  test("configuredApps come from metadata.app, never filename decode", async () => {
    const { files, dependencies } = makeHarness();
    files.set(`${directory}/.lando-routing-state`, "http://127.0.0.1:8080\nhttps://127.0.0.1:8443\n");
    const app = AppId.make("renamed-app");
    const content = [
      renderRouteFileMetadata(app),
      "http:",
      "  routers:",
      "    r:",
      `      rule: ${JSON.stringify('Host("web.example")')}`,
      "      entryPoints: [web]",
      "",
    ].join("\n");
    files.set(`${directory}/routes-${ownerKey}.yml`, content);
    // Legacy slug file must not contribute configuredApps via filename decode.
    files.set(
      `${directory}/routes-old-slug.yml`,
      [
        "http:",
        "  routers:",
        "    r:",
        `      rule: ${JSON.stringify('Host("old.example")')}`,
        "      entryPoints: [web]",
        "",
      ].join("\n"),
    );

    const status = await Effect.runPromise(persistedStatus(dependencies));

    expect(status.configuredApps).toEqual([app]);
    expect(status.configuredApps.map(String)).not.toContain(ownerKey);
    expect(status.configuredApps.map(String)).not.toContain("old-slug");
    expect(status.authorities.some((authority) => authority.hostname === "web.example")).toBe(true);
    expect(status.authorities.some((authority) => authority.hostname === "old.example")).toBe(false);
  });

  test("hex-named file without metadata is ignored for configuredApps", async () => {
    const { files, dependencies } = makeHarness();
    files.set(`${directory}/.lando-routing-state`, "http://127.0.0.1:8080\n");
    files.set(`${directory}/routes-${ownerKey}.yml`, "http:\n  routers: {}\n");

    const status = await Effect.runPromise(persistedStatus(dependencies));
    expect(status.configuredApps).toEqual([]);
  });
});
