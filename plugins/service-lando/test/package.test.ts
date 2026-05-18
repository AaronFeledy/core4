import { describe, expect, test } from "bun:test";
import { Layer } from "effect";

describe("@lando/service-lando package", () => {
  test("exports the package skeleton", async () => {
    const plugin = await import("@lando/service-lando");

    expect(plugin.PLUGIN_NAME).toBe("@lando/service-lando");
    expect(plugin.serviceTypes).toBeInstanceOf(Map);
    expect([...plugin.serviceTypes.keys()]).toEqual([
      "apache",
      "compose",
      "mariadb",
      "mysql",
      "nginx",
      "node:lts",
      "node:22",
      "postgres",
      "php:8.2",
      "php:8.3",
      "python:3.12",
      "redis",
      "ruby:3.3",
      "static",
      "static:caddy",
    ]);
    expect(Layer.isLayer(plugin.services)).toBe(true);
    expect(plugin.manifest).toMatchObject({
      name: "@lando/service-lando",
      version: "0.0.0",
      api: 4,
      contributes: {
        serviceTypes: [
          "apache",
          "compose",
          "mariadb",
          "mysql",
          "nginx",
          "node:lts",
          "node:22",
          "postgres",
          "php:8.2",
          "php:8.3",
          "python:3.12",
          "redis",
          "ruby:3.3",
          "static",
          "static:caddy",
        ],
      },
    });
  });
});
