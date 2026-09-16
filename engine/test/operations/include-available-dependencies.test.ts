import { expect, test } from "bun:test";

import { includeAvailableDependencies } from "../../src/operations/ensure-global-services.ts";

test("partial selection includes available dependsOn services and skips unrelated ones", () => {
  const selected = includeAvailableDependencies(
    ["traefik"],
    [
      { name: "traefik", dependsOn: [{ service: "traefik-diagnostics" }] },
      { name: "traefik-diagnostics", dependsOn: [] },
      { name: "unrelated", dependsOn: [] },
    ],
  );

  expect([...selected].sort()).toEqual(["traefik", "traefik-diagnostics"]);
});

test("partial selection does not invent services missing from the plan", () => {
  const selected = includeAvailableDependencies(
    ["traefik"],
    [{ name: "traefik", dependsOn: [{ service: "missing-backend" }] }],
  );

  expect([...selected]).toEqual(["traefik"]);
});
