import { expect, test } from "bun:test";
import { ServiceName } from "@lando/sdk/schema";
import { loadBuiltinRecipe } from "../_support/recipe-output.ts";

test.each([
  { id: "astro", port: 4321, env: { ASTRO_TELEMETRY_DISABLED: "1" } },
  { id: "nextjs", port: 3000, env: { NEXTAUTH_PROVIDER: "none" } },
  { id: "sveltekit", port: 5173, env: { SVELTEKIT_ADAPTER: "node" } },
])("$id preserves source-defined web variants through the common compiler", async ({ id, port, env }) => {
  const withoutDatabase = await loadBuiltinRecipe(id, { database: "none" });
  const withDatabase = await loadBuiltinRecipe(id, { database: "postgres" });
  expect(withoutDatabase.document.services?.[ServiceName.make("web")]).toMatchObject({
    type: "node:lts",
    port,
    environment: env,
    routes: [{ hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" }],
  });
  expect(withoutDatabase.document.services?.[ServiceName.make("web")]?.dependsOn).toBeUndefined();
  expect(withoutDatabase.document.services?.[ServiceName.make("database")]).toBeUndefined();
  expect(withDatabase.document.services?.[ServiceName.make("database")]?.type).toBe("postgres");
  expect(withDatabase.document.services?.[ServiceName.make("web")]?.dependsOn).toEqual([
    { service: "database" },
  ]);
});
