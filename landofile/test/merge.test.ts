import { describe, expect, test } from "bun:test";

import { mergeLandofiles } from "../src/merge.ts";

describe("mergeLandofiles", () => {
  test("deep-merges maps with later scalar precedence", () => {
    const result = mergeLandofiles<Record<string, unknown>>([
      { services: { appserver: { type: "node", environment: { A: "1", B: "base" } } } },
      { services: { appserver: { environment: { B: "override", C: "2" } } } },
    ]);

    expect(result).toEqual({
      services: { appserver: { type: "node", environment: { A: "1", B: "override", C: "2" } } },
    });
  });

  test("replaces scalar arrays instead of concatenating", () => {
    const result = mergeLandofiles<Record<string, unknown>>([
      { services: { web: { ports: ["80", "443"] } } },
      { services: { web: { ports: ["3000"] } } },
    ]);

    expect(result).toEqual({ services: { web: { ports: ["3000"] } } });
  });

  test("merges object arrays by the first recognized identity key", () => {
    const result = mergeLandofiles<Record<string, unknown>>([
      { services: { web: { routes: [{ hostname: "old.lndo.site", pathPrefix: "/" }] } } },
      {
        services: {
          web: { routes: [{ hostname: "old.lndo.site", scheme: "https" }, { hostname: "new.lndo.site" }] },
        },
      },
    ]);

    expect(result).toEqual({
      services: {
        web: {
          routes: [
            { hostname: "old.lndo.site", pathPrefix: "/", scheme: "https" },
            { hostname: "new.lndo.site" },
          ],
        },
      },
    });
  });

  test("replaces arrays of objects that have no recognized identity key", () => {
    const result = mergeLandofiles<Record<string, unknown>>([
      { services: { web: { mounts: [{ source: "./one", target: "/one" }] } } },
      { services: { web: { mounts: [{ source: "./two", target: "/two" }] } } },
    ]);

    expect(result).toEqual({ services: { web: { mounts: [{ source: "./two", target: "/two" }] } } });
  });

  test("folds files low to high precedence so the including file wins", () => {
    const result = mergeLandofiles<Record<string, unknown>>([
      { name: "base", services: { web: { type: "php" } } },
      { name: "final", services: { web: { type: "node" } } },
    ]);

    expect(result).toEqual({ name: "final", services: { web: { type: "node" } } });
  });

  test("merges route filters by name then unnamed type identity, preserving first-appearance order", () => {
    const result = mergeLandofiles<Record<string, unknown>>([
      {
        filters: [
          { type: "requestHeader", header: "X-A", value: "1" },
          { name: "strip", type: "stripPrefix", prefix: "/a" },
        ],
      },
      {
        filters: [
          { name: "strip", type: "stripPrefix", prefix: "/b" },
          { type: "requestHeader", header: "X-A", value: "2" },
        ],
      },
    ]);

    expect(result).toEqual({
      filters: [
        { type: "requestHeader", header: "X-A", value: "2" },
        { name: "strip", type: "stripPrefix", prefix: "/b" },
      ],
    });
  });

  test("never matches a named filter against an unnamed one", () => {
    const result = mergeLandofiles<Record<string, unknown>>([
      { filters: [{ name: "auth", type: "requestHeader", header: "X-A", value: "1" }] },
      { filters: [{ type: "requestHeader", header: "X-A", value: "2" }] },
    ]);

    expect(result).toEqual({
      filters: [
        { name: "auth", type: "requestHeader", header: "X-A", value: "1" },
        { type: "requestHeader", header: "X-A", value: "2" },
      ],
    });
  });

  test("does not collapse mount entries by type", () => {
    const result = mergeLandofiles<Record<string, unknown>>([
      {
        services: {
          web: {
            mounts: [
              { type: "bind", target: "/a" },
              { type: "volume", target: "/b" },
            ],
          },
        },
      },
      { services: { web: { mounts: [{ type: "bind", target: "/c" }] } } },
    ]);

    expect(result).toEqual({ services: { web: { mounts: [{ type: "bind", target: "/c" }] } } });
  });

  test("merges filters nested under routes matched by hostname", () => {
    const result = mergeLandofiles<Record<string, unknown>>([
      {
        services: {
          web: {
            routes: [
              {
                hostname: "app.lndo.site",
                filters: [
                  { type: "requestHeader", header: "X-A", value: "1" },
                  { name: "strip", type: "stripPrefix", prefix: "/a" },
                ],
              },
            ],
          },
        },
      },
      {
        services: {
          web: {
            routes: [
              {
                hostname: "app.lndo.site",
                filters: [
                  { name: "strip", type: "stripPrefix", prefix: "/b" },
                  { type: "requestHeader", header: "X-A", value: "2" },
                ],
              },
            ],
          },
        },
      },
    ]);

    expect(result).toEqual({
      services: {
        web: {
          routes: [
            {
              hostname: "app.lndo.site",
              filters: [
                { type: "requestHeader", header: "X-A", value: "2" },
                { name: "strip", type: "stripPrefix", prefix: "/b" },
              ],
            },
          ],
        },
      },
    });
  });
});
