import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const script = pathToFileURL(join(import.meta.dir, "../scripts/build.mjs")).href;
let root: string;
let externalRequests = 0;
const external = createServer((_request, response) => {
  externalRequests++;
  response.writeHead(503).end();
});
let externalUrl: string;

beforeAll(async () => {
  root = await mkdtemp(join(import.meta.dir, "../../node_modules/.link-check-fixture-"));
  await mkdir(join(root, "src/pages"), { recursive: true });
  await mkdir(join(root, "public"));
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await writeFile(join(root, "public/pixel.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(join(root, "public/styles.css"), 'body { background: url("./pixel.svg"); }');
  await new Promise<void>((resolve) => external.listen(0, "127.0.0.1", resolve));
  const address = external.address();
  if (!address || typeof address === "string") throw new Error("Missing external test server address");
  externalUrl = `http://127.0.0.1:${address.port}/external#missing`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    external.close((error) => (error ? reject(error) : resolve())),
  );
  await rm(root, { recursive: true, force: true });
});

async function runBuild(extra = "", base = "/nested/docs/", trailingSlash = "always") {
  const targetRoute = `${base}target${trailingSlash === "never" ? "" : "/"}`;
  await writeFile(
    join(root, "src/pages/index.astro"),
    `<html><head><link rel="stylesheet" href="${base}styles.css" /></head><body>
      <h1 id="local">Home</h1><a href="#local">local</a>
      <a href="https://docs.example.test${targetRoute}#caf%C3%A9">absolute</a>
      <a href="${targetRoute}#named">named</a>
      <a href="${externalUrl}">external</a><a href="mailto:test@example.test">mail</a>
      <img src="${base}pixel.svg" />${extra}</body></html>`,
  );
  await writeFile(
    join(root, "src/pages/target.astro"),
    '<html><h1 id="café">Target</h1><a name="named"></a></html>',
  );
  // This page is deliberately absent from navigation.
  await writeFile(join(root, "src/pages/orphan.astro"), '<html><h1 id="orphan">Orphan</h1></html>');
  await writeFile(
    join(root, "src/pages/404.astro"),
    '<html><a href="#error">Error</a><h1 id="error">404</h1></html>',
  );
  const config = {
    root,
    configFile: false,
    base,
    site: "https://docs.example.test",
    trailingSlash,
    logLevel: "error",
  };
  const child = Bun.spawn(
    [
      "node",
      "--input-type=module",
      "-e",
      `import {buildAndCheck} from ${JSON.stringify(script)}; await buildAndCheck(${JSON.stringify(config)});`,
    ],
    {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1" },
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, output: stdout + stderr };
}

describe("build-time internal links", () => {
  test("builds all pages and checks local assets, CSS, Unicode and named anchors without external requests", async () => {
    const result = await runBuild();
    expect(result.output).toContain("4 built pages");
    expect(result.exitCode).toBe(0);
    expect(externalRequests).toBe(0);
  }, 60_000);

  test.each([
    ['<a href="/nested/docs/missing/">missing page</a>', "missing/"],
    ['<img src="/nested/docs/missing.png" />', "missing.png"],
    ['<a href="#missing-local">bad local anchor</a>', "#missing-local"],
    ['<a href="/nested/docs/target/#missing-cross">bad remote anchor</a>', "#missing-cross"],
    ['<a href="/target/">missing base</a>', "/target/"],
  ])(
    "fails the build for %s",
    async (extra, target) => {
      const result = await runBuild(extra);
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("Internal link check failed");
      expect(result.output).toContain(target);
      expect(await readFile(join(root, "dist/index.html"), "utf8")).toContain("Home");
    },
    60_000,
  );

  test("finds broken links on an orphan page and inside CSS", async () => {
    await writeFile(join(root, "public/orphan.html"), '<a href="/nested/docs/orphan-missing/">bad</a>');
    await writeFile(join(root, "public/orphan.css"), 'body { background: url("./css-missing.png"); }');
    try {
      const result = await runBuild();
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("orphan-missing/");
      expect(result.output).toContain("css-missing.png");
    } finally {
      await rm(join(root, "public/orphan.html"));
      await rm(join(root, "public/orphan.css"));
    }
  }, 60_000);

  test("supports a root base with trailingSlash never", async () => {
    const result = await runBuild("", "/", "never");
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("4 built pages");
  }, 60_000);
});
