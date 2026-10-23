import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, preview } from "astro";
import { LinkChecker, LinkState } from "linkinator";

async function builtPaths(directory, prefix = "") {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      paths.push(...(await builtPaths(join(directory, entry.name), `${relative}/`)));
    } else if (entry.isFile() && /\.(html|css)$/.test(entry.name)) {
      paths.push(relative);
    }
  }
  return paths.sort();
}

export async function checkBuiltLinks(config, server) {
  const paths = await builtPaths(fileURLToPath(config.outDir));
  const pages = paths.filter((path) => path.endsWith(".html"));
  if (pages.length === 0) throw new Error("Link check found no built HTML pages.");
  const origin = `http://127.0.0.1:${server.port}`;
  const base = `${config.base.replace(/\/$/, "")}/`;
  const checker = new LinkChecker();
  const siteOrigin = config.site ? new URL(config.site).origin : undefined;
  const result = await checker.check({
    path: paths.map((page) => {
      let route = page.replace(/(^|\/)index\.html$/, "$1");
      if (config.trailingSlash === "never") route = route.replace(/\/$/, "");
      return `${origin}${base}${route.split("/").map(encodeURIComponent).join("/")}`;
    }),
    recurse: true,
    checkFragments: true,
    checkCss: true,
    concurrency: 20,
    timeout: 10_000,
    urlRewriteExpressions: siteOrigin
      ? [
          {
            pattern: new RegExp(`^${siteOrigin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=/|$)`),
            replacement: origin,
          },
        ]
      : [],
    linksToSkip: async (link) => new URL(link).origin !== origin,
  });
  const broken = result.links.filter((link) => link.state === LinkState.BROKEN);
  if (!result.passed) {
    const failures = broken.map(
      (link) => `${link.parent ?? "(built page)"} -> ${link.url} (${link.status ?? "request failed"})`,
    );
    throw new Error(`Internal link check failed (${broken.length} errors):\n${failures.join("\n")}`);
  }
  console.log(
    `Internal link check passed: ${pages.length} built pages, ${result.links.length} link results.`,
  );
  return result;
}

export async function buildAndCheck(inlineConfig = {}) {
  let resolvedConfig;
  const config = {
    root: fileURLToPath(new URL("../", import.meta.url)),
    ...inlineConfig,
    integrations: [
      ...(inlineConfig.integrations ?? []),
      {
        name: "capture-link-check-config",
        hooks: {
          "astro:config:done": ({ config }) => {
            resolvedConfig = config;
          },
        },
      },
    ],
  };
  await build(config);
  if (!resolvedConfig) throw new Error("Astro did not resolve its build configuration.");
  const server = await preview({
    ...config,
    base: resolvedConfig.base,
    outDir: fileURLToPath(resolvedConfig.outDir),
    server: { host: "127.0.0.1", port: 0, open: false },
  });
  try {
    return await checkBuiltLinks(resolvedConfig, server);
  } finally {
    await server.stop();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    await buildAndCheck();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
