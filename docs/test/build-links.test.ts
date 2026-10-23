import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { LinkResult } from "linkinator";

const script = pathToFileURL(join(import.meta.dir, "../scripts/build.mjs")).href;
const linkinator = import.meta.resolve("linkinator");
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

async function runBuild(
  extra = "",
  base = "/nested/docs/",
  trailingSlash = "always",
  options: { errorExtra?: string; targetExtra?: string; targetHead?: string } = {},
) {
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
    `<html><head>${options.targetHead ?? ""}</head><body><h1 id="café">Target</h1><a name="named"></a>${options.targetExtra ?? ""}</body></html>`,
  );
  // This page is deliberately absent from navigation.
  await writeFile(join(root, "src/pages/orphan.astro"), '<html><h1 id="orphan">Orphan</h1></html>');
  await writeFile(
    join(root, "src/pages/404.astro"),
    `<html><head>
      <link rel="canonical" href="https://docs.example.test${base}404${trailingSlash === "never" ? "" : "/"}" />
      <meta property="og:url" content="https://docs.example.test${base}404${trailingSlash === "never" ? "" : "/"}" />
      </head><body><a href="#error">Error</a><h1 id="error">404</h1>
      <a href="${targetRoute}#named">navigation</a><img src="${base}pixel.svg" />${options.errorExtra ?? ""}</body></html>`,
  );
  const config = {
    root,
    configFile: false,
    base,
    site: "https://docs.example.test",
    trailingSlash,
    logLevel: "error",
  };
  const runner = join(root, "run-build.mjs");
  await writeFile(
    runner,
    `import {buildAndCheck} from ${JSON.stringify(script)};
       import {LinkChecker} from ${JSON.stringify(linkinator)};
       const check = LinkChecker.prototype.check;
       LinkChecker.prototype.check = async function(options) {
         const result = await check.call(this, options);
         console.log("LINK_RESULTS:" + JSON.stringify(result.links));
         console.log("LINKINATOR_PASSED:" + result.passed);
         return result;
       };
       await buildAndCheck(${JSON.stringify(config)});`,
  );
  const child = Bun.spawn(["node", runner], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1" },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const links: LinkResult[] = JSON.parse(/^LINK_RESULTS:(.*)$/m.exec(stdout)?.[1] ?? "[]");
  return {
    exitCode,
    output: stdout + stderr,
    links,
    upstreamPassed: stdout.includes("LINKINATOR_PASSED:true"),
  };
}

describe("build-time internal links", () => {
  test("builds all pages and checks local assets, CSS, Unicode and named anchors without external requests", async () => {
    const result = await runBuild();
    expect(result.output).toContain("4 built pages");
    expect(result.exitCode).toBe(0);
    expect(externalRequests).toBe(0);
    const absoluteAnchor = result.links.filter(
      (link) => new URL(link.url).pathname === "/nested/docs/target/",
    );
    expect(absoluteAnchor.length).toBeGreaterThan(0);
    expect(absoluteAnchor.every((link) => link.state === "OK")).toBe(true);
    expect(result.links.some((link) => link.url === externalUrl && link.state === "SKIPPED")).toBe(true);
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

  test.each([
    [
      '<a href="https://docs.example.test/nested/docs/absolute-missing/">bad route</a>',
      "/nested/docs/absolute-missing/",
    ],
    [
      '<img src="https://docs.example.test/nested/docs/absolute-missing.png" />',
      "/nested/docs/absolute-missing.png",
    ],
    [
      '<a href="https://docs.example.test/nested/docs/target/#absolute-missing">bad fragment</a>',
      "/nested/docs/target/#absolute-missing",
    ],
  ])(
    "checks absolute production-site URLs: %s",
    async (extra, target) => {
      const result = await runBuild(extra);
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("Internal link check failed");
      const references = result.links.filter((link) => {
        const url = new URL(link.url);
        return `${url.pathname}${url.hash}` === target;
      });
      expect(references.length).toBeGreaterThan(0);
      expect(references.every((link) => link.state !== "SKIPPED")).toBe(true);
      expect(references.some((link) => link.state === "BROKEN")).toBe(true);
      expect(externalRequests).toBe(0);
    },
    60_000,
  );

  test.each([
    '<a href="/nested/docs/error-route-missing/">bad navigation</a>',
    '<img src="/nested/docs/error-image-missing.png" />',
    '<a href="#error-anchor-missing">bad anchor</a>',
  ])(
    "checks links on the Starlight-shaped 404 page: %s",
    async (extra) => {
      const result = await runBuild("", "/nested/docs/", "always", { errorExtra: extra });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("Internal link check failed");
      expect(result.links.some((link) => link.parent?.endsWith("/404.html") && link.state === "BROKEN")).toBe(
        true,
      );
    },
    60_000,
  );

  test("strict fragments reject missing anchors on noindex,nofollow HTML", async () => {
    const result = await runBuild(
      '<a href="https://docs.example.test/nested/docs/target/#robots-missing">bad</a>',
      "/nested/docs/",
      "always",
      {
        targetHead: '<meta name="robots" content="noindex,nofollow" />',
      },
    );
    expect(result.upstreamPassed).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("#robots-missing");
  }, 60_000);

  test("strict fragments do not invent a target from an anchor's own href", async () => {
    const result = await runBuild("", "/nested/docs/", "always", {
      targetExtra: '<a id="present" href="#anchor-missing">bad</a>',
    });
    expect(result.upstreamPassed).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("#anchor-missing");
  }, 60_000);

  test("keeps valid decoded IDs and legacy names on noindex,nofollow HTML", async () => {
    const result = await runBuild("", "/nested/docs/", "always", {
      targetHead: '<meta name="robots" content="noindex,nofollow" />',
      targetExtra: '<a id="present" href="#present">valid</a>',
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("strict HTML fragments");
  }, 60_000);

  test("the real package command preserves base, site and outDir overrides and propagates failures", async () => {
    const cliRoot = join(root, "cli-project");
    await mkdir(join(cliRoot, "src/pages"), { recursive: true });
    await mkdir(join(cliRoot, "scripts"));
    await mkdir(join(cliRoot, "public"));
    await copyFile(new URL(script), join(cliRoot, "scripts/build.mjs"));
    await copyFile(new URL("./strict-fragments.mjs", script), join(cliRoot, "scripts/strict-fragments.mjs"));
    await copyFile(join(root, "public/pixel.svg"), join(cliRoot, "public/pixel.svg"));
    await writeFile(
      join(cliRoot, "package.json"),
      JSON.stringify({ type: "module", scripts: { build: "node scripts/build.mjs" } }),
    );
    await writeFile(
      join(cliRoot, "astro.config.mjs"),
      'export default { base: "/configured/", site: "https://configured.invalid", outDir: "./configured-dist", logLevel: "error" };',
    );
    const page = `---
const base = import.meta.env.BASE_URL;
---
<html><h1 id="café">CLI</h1><a href={new URL(base + "#caf%C3%A9", Astro.site).href}>valid</a><img src={base + "pixel.svg"} /></html>`;
    const source = join(cliRoot, "src/pages/index.astro");
    await writeFile(source, page);
    const run = async (args: string[]) => {
      const child = Bun.spawn(["bun", "run", "--cwd", cliRoot, "build", ...args], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1" },
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exitCode, output: stdout + stderr };
    };
    const args = ["--base", "/preview/", "--site=https://preview.example.test", "--outDir", "./publish"];
    const valid = await run(args);
    expect(valid.exitCode).toBe(0);
    expect(valid.output).toContain("1 built pages");
    const published = join(cliRoot, "publish/index.html");
    expect(await readFile(published, "utf8")).toContain("https://preview.example.test/preview/#caf%C3%A9");
    expect(await Bun.file(join(cliRoot, "configured-dist/index.html")).exists()).toBe(false);
    await writeFile(source, `${page}<a href="https://preview.example.test/preview/#cli-missing">bad</a>`);
    const invalid = await run(args);
    expect(invalid.exitCode).not.toBe(0);
    expect(invalid.output).toContain("#cli-missing");
    expect(await readFile(published, "utf8")).toContain("cli-missing");
    const unsupported = await run(["--not-an-astro-flag"]);
    expect(unsupported.exitCode).not.toBe(0);
    expect(unsupported.output).toContain("Unsupported docs build argument");
    expect(externalRequests).toBe(0);
  }, 60_000);

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
