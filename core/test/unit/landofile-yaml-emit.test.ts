import { describe, expect, test } from "bun:test";

import { Effect, Schema } from "effect";

import { emitLandofileYaml } from "@lando/sdk/landofile";
import { LandofileShape } from "@lando/sdk/schema";

import { parseLandofile } from "../../src/landofile/parser.ts";

const roundTrip = async (value: Record<string, unknown>): Promise<unknown> => {
  const yaml = emitLandofileYaml(value);
  return Effect.runPromise(parseLandofile({ file: ".lando.yml", content: yaml, cwd: "/tmp" }));
};

describe("emitLandofileYaml — round-trips through the Landofile parser", () => {
  test("scalars: string, number, boolean, null", async () => {
    const value = { name: "my-app", runtime: 4, enabled: true, disabled: false, nothing: null };
    expect(await roundTrip(value)).toEqual(value);
  });

  test("quotes number-looking and reserved-word strings so they stay strings", async () => {
    const value = { version: "8.0", flag: "true", empty: "", nullish: "null" };
    expect(await roundTrip(value)).toEqual(value);
  });

  test("quotes strings with structural characters and whitespace", async () => {
    const value = { greeting: "hello world", note: "a: b", hash: "trailing # hash", lead: "- dashy" };
    expect(await roundTrip(value)).toEqual(value);
  });

  test("escapes newlines and quotes in double-quoted scalars", async () => {
    const value = { multi: "line1\nline2\ttab", quoted: 'say "hi"' };
    expect(await roundTrip(value)).toEqual(value);
  });

  test("nested maps", async () => {
    const value = {
      name: "app",
      services: { web: { type: "php:8.3", webroot: "web" }, db: { type: "mysql:8.0" } },
    };
    expect(await roundTrip(value)).toEqual(value);
  });

  test("scalar arrays", async () => {
    const value = { name: "app", tags: ["a", "b", "c"], ports: [80, 443] };
    expect(await roundTrip(value)).toEqual(value);
  });

  test("arrays of maps", async () => {
    const value = {
      includes: [
        { source: "git@example.com", resolved: "abc", checksum: "deadbeef" },
        { source: "npm:pkg", resolved: "1.0.0", checksum: "cafef00d" },
      ],
    };
    expect(await roundTrip(value)).toEqual(value);
  });

  test("empty map and empty array round-trip as {} and []", async () => {
    const value = { name: "app", services: {}, tags: [] };
    expect(await roundTrip(value)).toEqual(value);
  });

  test("a merged LandofileShape re-decodes after emit", async () => {
    const merged = {
      name: "translated-app",
      runtime: 4 as const,
      services: { db: { type: "mysql:8.0" }, cache: { type: "redis:7" } },
      tooling: { migrate: { service: "db", cmd: "echo migrate" } },
    };
    const yaml = emitLandofileYaml(merged);
    const parsed = await Effect.runPromise(
      parseLandofile({ file: ".lando.yml", content: yaml, cwd: "/tmp" }),
    );
    const decoded = Schema.decodeUnknownSync(LandofileShape)(parsed, { onExcessProperty: "error" });
    expect(decoded.name).toBe("translated-app");
    expect(decoded.services?.db?.type).toBe("mysql:8.0");
    expect(decoded.tooling?.migrate?.cmd).toBe("echo migrate");
  });
});
