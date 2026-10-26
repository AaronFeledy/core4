import { RouteInput } from "@lando/sdk/schema";

import type { NamedContractTable } from "./types.ts";

export const table = {
  name: "RouteInput",
  schema: RouteInput,
  accepted: [
    { name: "hostname shorthand", input: "appserver.lndo.site", expected: "appserver.lndo.site" },
    {
      name: "object hostname",
      input: { hostname: "web.lndo.site" },
      expected: { hostname: "web.lndo.site" },
    },
    {
      name: "object with scheme and path",
      input: { hostname: "web.lndo.site", scheme: "https", pathPrefix: "/api" },
      expected: { hostname: "web.lndo.site", scheme: "https", pathPrefix: "/api" },
    },
    {
      name: "object with endpoint port",
      input: { hostname: "api.lndo.site", endpoint: 8080 },
      expected: { hostname: "api.lndo.site", endpoint: 8080 },
    },
  ],
  rejected: [
    { name: "empty string", input: "", expectedErrorFragment: "at least 1" },
    { name: "number", input: 8080, expectedErrorFragment: "string" },
    { name: "missing hostname object", input: { scheme: "https" }, expectedErrorFragment: "hostname" },
  ],
} as const satisfies NamedContractTable;
