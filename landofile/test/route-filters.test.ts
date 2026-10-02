import { describe, expect, test } from "bun:test";

import { attachRouteFilter } from "../src/route-filters.ts";

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
