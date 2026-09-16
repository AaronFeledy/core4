import { describe, expect, test } from "bun:test";

import { attachRouteFilter, routeFilterIdentity, routeFilterMatches } from "../src/route-filters.ts";

describe("routeFilterIdentity", () => {
  test("uses name when the entry has one", () => {
    const named = routeFilterIdentity({ name: "strip", type: "stripPrefix", prefix: "/a" });
    const sameName = routeFilterIdentity({ name: "strip", type: "addPrefix", prefix: "/b" });
    const otherName = routeFilterIdentity({ name: "other", type: "stripPrefix", prefix: "/a" });

    expect(named).toBeDefined();
    expect(named).toEqual(sameName);
    expect(named).not.toEqual(otherName);
  });

  test("falls back to type when the entry is unnamed", () => {
    const unnamed = routeFilterIdentity({ type: "requestHeader", header: "X-A", value: "1" });
    const sameType = routeFilterIdentity({ type: "requestHeader", header: "X-B", value: "2" });
    const otherType = routeFilterIdentity({ type: "stripPrefix", prefix: "/a" });

    expect(unnamed).toBeDefined();
    expect(unnamed).toEqual(sameType);
    expect(unnamed).not.toEqual(otherType);
  });

  test("keeps named and unnamed identities distinct even when name equals type", () => {
    expect(routeFilterIdentity({ name: "requestHeader" })).not.toEqual(
      routeFilterIdentity({ type: "requestHeader" }),
    );
  });

  test("returns undefined for non-records and entries without name or type", () => {
    expect(routeFilterIdentity("nope")).toBeUndefined();
    expect(routeFilterIdentity(null)).toBeUndefined();
    expect(routeFilterIdentity({ header: "X-A" })).toBeUndefined();
  });
});

describe("routeFilterMatches", () => {
  test("matches named filters by name", () => {
    expect(
      routeFilterMatches(
        { name: "strip", type: "stripPrefix", prefix: "/a" },
        { name: "strip", type: "addPrefix", prefix: "/b" },
      ),
    ).toBe(true);
  });

  test("matches unnamed filters by type", () => {
    expect(
      routeFilterMatches(
        { type: "requestHeader", header: "X-A", value: "1" },
        { type: "requestHeader", header: "X-B", value: "2" },
      ),
    ).toBe(true);
  });

  test("never matches a named filter against an unnamed one", () => {
    expect(
      routeFilterMatches(
        { name: "strip", type: "stripPrefix", prefix: "/a" },
        { type: "stripPrefix", prefix: "/b" },
      ),
    ).toBe(false);
  });

  test("does not match when identity is missing", () => {
    expect(routeFilterMatches({ type: "requestHeader" }, { header: "X-A" })).toBe(false);
    expect(routeFilterMatches("nope", { type: "requestHeader" })).toBe(false);
  });
});

describe("attachRouteFilter", () => {
  test("attachRouteFilter replaces by name then unnamed type and is idempotent", () => {
    const route = {
      hostname: "app.lndo.site",
      filters: [
        { name: "strip", type: "stripPrefix", prefix: "/old" },
        { type: "addPrefix", prefix: "/api" },
      ],
    };
    const named = { name: "strip", type: "stripPrefix", prefix: "/new" };
    const unnamed = { type: "addPrefix", prefix: "/v2" };

    const afterName = attachRouteFilter(route, named);
    expect(afterName).toEqual({
      hostname: "app.lndo.site",
      filters: [named, { type: "addPrefix", prefix: "/api" }],
    });

    const afterType = attachRouteFilter(afterName, unnamed);
    expect(afterType).toEqual({
      hostname: "app.lndo.site",
      filters: [named, unnamed],
    });

    expect(attachRouteFilter(afterType, named)).toEqual(afterType);
    expect(attachRouteFilter(afterType, unnamed)).toEqual(afterType);
  });
});
