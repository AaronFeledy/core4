import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("init --registry-url acquires an npm recipe from the selected registry", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-registry-override-"));
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const openssl = Bun.spawn(
      [
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "2",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
        "-keyout",
        join(root, "key.pem"),
        "-out",
        join(root, "ca.pem"),
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    const [tlsCode, tlsError] = await Promise.all([openssl.exited, new Response(openssl.stderr).text()]);
    expect(tlsCode, tlsError).toBe(0);
    const cert = await readFile(join(root, "ca.pem"), "utf8");
    const key = await readFile(join(root, "key.pem"), "utf8");
    await mkdir(join(root, "package"));
    await writeFile(
      join(root, "package", "recipe.yml"),
      "id: custom-registry\ntitle: Custom\ndescription: Fixture\nversion: 1.0.0\nconfig:\n  runtime: 4\n",
    );
    const tar = Bun.spawn(["tar", "-czf", join(root, "package.tgz"), "-C", root, "package"], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const [tarCode, tarError] = await Promise.all([tar.exited, new Response(tar.stderr).text()]);
    expect(tarCode, tarError).toBe(0);
    const bytes = await readFile(join(root, "package.tgz"));
    const integrity = `sha512-${new Bun.CryptoHasher("sha512").update(bytes).digest("base64")}`;
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { cert, key },
      fetch: (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/archive.tgz") return new Response(bytes);
        if (url.pathname !== "/demo") return new Response("not found", { status: 404 });
        return Response.json({
          "dist-tags": { latest: "1.0.0" },
          versions: { "1.0.0": { dist: { tarball: `${url.origin}/archive.tgz`, integrity } } },
        });
      },
    });
    const child = Bun.spawn(
      [
        process.execPath,
        new URL("../../bin/lando.ts", import.meta.url).pathname,
        "init",
        join(root, "app"),
        "--source=npm",
        "--package=demo",
        `--registry-url=${server.url.origin}`,
        "--name=registry-demo",
        "--yes",
        "--format=json",
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          npm_config_registry: "https://unreachable.invalid/",
          NPM_CONFIG_USERCONFIG: join(root, "absent-config"),
          LANDO_NETWORK_CA_CERTS: JSON.stringify([join(root, "ca.pem")]),
          LANDO_USER_CACHE_ROOT: join(root, "cache"),
          LANDO_USER_DATA_ROOT: join(root, "data"),
          LANDO_USER_CONF_ROOT: join(root, "conf"),
          LANDO_SYSTEM_PLUGIN_ROOT: join(root, "system"),
          LANDO_TELEMETRY: "off",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, stdout + stderr).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ ok: true });
    expect(await readFile(join(root, "app", ".lando.yml"), "utf8")).toContain("name: registry-demo");
  } finally {
    await server?.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});
