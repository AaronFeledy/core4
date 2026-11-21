import { describe, expect, test } from "bun:test";

import { attachRouteFilter } from "../src/route-filters.ts";

describe("attachRouteFilter", () => {
  test("attachRouteFilter replaces by name then unnamed type and is idempotent", () => {
    const route = {
      hostname: "app.lndo.site",
      filters: [
        { name: "strip", kind: "stripPrefix", prefix: "/old" },
        { kind: "addPrefix", prefix: "/api" },
      ],
    };
    const named = { name: "strip", kind: "stripPrefix", prefix: "/new" };
    const unnamed = { kind: "addPrefix", prefix: "/v2" };

    const afterName = attachRouteFilter(route, named);
    expect(afterName).toEqual({
      hostname: "app.lndo.site",
      filters: [named, { kind: "addPrefix", prefix: "/api" }],
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
