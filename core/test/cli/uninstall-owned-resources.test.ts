import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("native purge uses the bundled Podman hook with only its socket available", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lando-purge-http-")));
  const dataRoot = join(root, "data");
  const cacheRoot = join(root, "cache");
  mkdirSync(dataRoot);
  mkdirSync(cacheRoot);
  const socket = join(root, "fake.sock");
  const containers = new Map([
    ["owned", dataRoot],
    ["peer", join(root, "peer-data")],
    ["legacy", undefined],
  ]);
  let stopped = false;
  const server = Bun.serve({
    unix: socket,
    fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname.replace(/^\/v[\d.]+/u, "");
      if (path === "/_ping") return new Response("OK");
      if (path === "/containers/json") {
        const labels = url.searchParams.get("filters") ?? "";
        return Response.json(
          [...containers]
            .filter(
              ([, owner]) =>
                !labels.includes("dev.lando.data-root=") || labels.includes(`dev.lando.data-root=${owner}`),
            )
            .map(([Id]) => ({ Id })),
        );
      }
      if (path === "/containers/owned/stop" && request.method === "POST") {
        stopped = true;
        return new Response(null, { status: 204 });
      }
      if (
        path === "/containers/owned" &&
        request.method === "DELETE" &&
        stopped &&
        url.searchParams.get("v") === "true"
      ) {
        containers.delete("owned");
        return new Response(null, { status: 204 });
      }
      if (path.endsWith("/json") && path.startsWith("/containers/")) {
        const id = path.split("/")[2] ?? "";
        const owner = containers.get(id);
        return Response.json({
          Id: id,
          Config: {
            Labels: {
              "dev.lando.app": "web",
              "dev.lando.app-root": root,
              "dev.lando.service": "web",
              "dev.lando.provider": "podman",
              ...(owner === undefined ? {} : { "dev.lando.data-root": owner }),
            },
          },
        });
      }
      if (path === "/volumes") return Response.json({ Volumes: [] });
      if (path === "/networks" || path === "/images/json") return Response.json([]);
      return Response.json({ message: `Unexpected request: ${request.method} ${path}` }, { status: 500 });
    },
  });
  try {
    const run = async (flag: string) => {
      const proc = Bun.spawn(
        [
          process.execPath,
          resolve(import.meta.dirname, "../../bin/lando.ts"),
          "uninstall",
          "--purge",
          flag,
          "--format=json",
        ],
        {
          env: {
            ...process.env,
            PATH: join(root, "no-bin"),
            LANDO_USER_DATA_ROOT: dataRoot,
            LANDO_USER_CACHE_ROOT: cacheRoot,
            LANDO_USER_CONF_ROOT: join(root, "conf"),
            LANDO_SHELL_PROFILE: join(root, ".profile"),
            LANDO_TEST_DOCKER_SOCKET: join(root, "absent.sock"),
            LANDO_TEST_PODMAN_SOCKET: socket,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [exit, out, err] = await Promise.all([proc.exited, proc.stdout.text(), proc.stderr.text()]);
      if (exit !== 0) throw new Error(`Uninstall failed (${exit}): ${out}\n${err}`);
      return out;
    };
    const plan = await run("--dry-run");
    expect(plan).toContain(socket);
    expect(plan).toContain("1 container, 0 networks, 0 volumes, and 0 built images");
    expect(containers.has("owned")).toBe(true);
    expect(stopped).toBe(false);
    await run("--yes");
    expect([...containers.keys()]).toEqual(["peer", "legacy"]);
    expect(existsSync(dataRoot)).toBe(false);
    expect(existsSync(cacheRoot)).toBe(false);
  } finally {
    await server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
