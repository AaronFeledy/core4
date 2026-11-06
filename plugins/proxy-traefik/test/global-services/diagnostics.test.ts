import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

import {
  TRAEFIK_DIAGNOSTICS_CONTAINER_DIR,
  renderTraefikDiagnosticHtml,
  renderTraefikDiagnosticNginxConfig,
} from "../../src/diagnostics.ts";
import diagnostics, { TRAEFIK_DIAGNOSTICS_COMMAND } from "../../src/global-services/diagnostics.ts";
import { buildTraefikServiceConfig } from "../../src/global-services/traefik.ts";

test("reading the global diagnostic contribution leaves a fresh host root untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-diagnostic-global-"));
  const previous = process.env.LANDO_USER_DATA_ROOT;
  process.env.LANDO_USER_DATA_ROOT = root;
  try {
    const config = await Effect.runPromise(diagnostics);
    expect(await readdir(root)).toEqual([]);
    expect(config.mounts).toEqual([]);
    expect(config.healthcheck).toMatchObject({ kind: "command" });
    expect(config.home).toBe(false);
    expect(config.routes).toEqual([]);
    expect(buildTraefikServiceConfig({ http: 8080, https: 8443 }).dependsOn).toEqual([
      { service: "traefik-diagnostics", condition: "service_healthy", required: true },
    ]);
    expect(buildTraefikServiceConfig({ http: 8080, https: 8443 }).home).toBe(false);
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
    else process.env.LANDO_USER_DATA_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("container startup writes literal diagnostic assets before replacing the shell with nginx", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-diagnostic-startup-"));
  try {
    const directory = join(root, "assets");
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "nginx"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$LANDO_NGINX_ARGS"\n');
    await chmod(join(bin, "nginx"), 0o755);
    const script = TRAEFIK_DIAGNOSTICS_COMMAND[2];
    if (script === undefined) throw new Error("Missing diagnostics startup script");
    const process = Bun.spawn(
      ["sh", "-ec", script.replaceAll(TRAEFIK_DIAGNOSTICS_CONTAINER_DIR, directory)],
      {
        env: { ...Bun.env, PATH: `${bin}:${Bun.env.PATH}`, LANDO_NGINX_ARGS: join(root, "args") },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await process.exited).toBe(0);
    expect(await readFile(join(directory, "nginx.conf"), "utf8")).toBe(
      renderTraefikDiagnosticNginxConfig().replaceAll(TRAEFIK_DIAGNOSTICS_CONTAINER_DIR, directory),
    );
    expect(await readFile(join(directory, "404.html"), "utf8")).toBe(renderTraefikDiagnosticHtml());
    expect(await readFile(join(root, "args"), "utf8")).toBe(`-c\n${directory}/nginx.conf\n-g\ndaemon off;\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
