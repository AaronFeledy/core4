import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

import diagnostics from "../../src/global-services/diagnostics.ts";
import { buildTraefikServiceConfig } from "../../src/global-services/traefik.ts";

test("global diagnostic contribution prepares assets before the service can start", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-diagnostic-global-"));
  const previous = process.env.LANDO_USER_DATA_ROOT;
  process.env.LANDO_USER_DATA_ROOT = root;
  try {
    const config = await Effect.runPromise(diagnostics);
    const directory = join(root, "global/proxy-traefik/diagnostic");
    expect(await readFile(join(directory, "nginx.conf"), "utf8")).toContain("listen 8080");
    expect(await readFile(join(directory, "404.html"), "utf8")).toContain("<!doctype html>");
    expect(config.healthcheck).toMatchObject({ kind: "command" });
    expect(buildTraefikServiceConfig({ http: 8080, https: 8443 }).dependsOn).toEqual([
      { service: "traefik-diagnostics", condition: "service_healthy", required: true },
    ]);
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
    else process.env.LANDO_USER_DATA_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
});
