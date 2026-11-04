import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, preview } from "astro";
import { LinkChecker, LinkState } from "linkinator";
import { createSiteUrlPolicy } from "./site-urls.mjs";
import { checkStrictFragments } from "./strict-fragments.mjs";

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
  const siteUrls = createSiteUrlPolicy(config.site, origin);
  const urlFor = (page) => {
    let route = page.replace(/(^|\/)index\.html$/, "$1");
    if (config.trailingSlash === "never") route = route.replace(/\/$/, "");
    return `${origin}${base}${route.split("/").map(encodeURIComponent).join("/")}`;
  };
  const result = await checker.check({
    path: paths.map(urlFor),
    recurse: true,
    checkFragments: true,
    checkCss: true,
    concurrency: 20,
    timeout: 30_000,
    retryErrors: true,
    retryErrorsCount: 1,
    retryErrorsJitter: 0,
    urlRewriteExpressions: siteUrls.urlRewriteExpressions,
    linksToSkip: siteUrls.linksToSkip,
  });
  const strict = await checkStrictFragments(
    pages.map((page) => ({ file: join(fileURLToPath(config.outDir), page), url: urlFor(page) })),
    siteUrls.toLocalUrl,
  );
  for (const link of strict.links) {
    if (
      !result.links.some(
        (existing) =>
          existing.state === LinkState.BROKEN && existing.url === link.url && existing.parent === link.parent,
      )
    ) {
      result.links.push(link);
    }
  }
  const broken = result.links.filter((link) => link.state === LinkState.BROKEN);
  result.passed = broken.length === 0;
  if (!result.passed) {
    const failures = broken.map(
      (link) =>
        `${link.parent ?? "(built page)"} -> ${link.url} (${link.status ?? "request failed"})${
          link.failureDetails
            ?.filter((detail) => detail instanceof Error)
            .map((detail) => ` ${detail.name}: ${detail.message}`)
            .join("") ?? ""
        }`,
    );
    throw new Error(`Internal link check failed (${broken.length} errors):\n${failures.join("\n")}`);
  }
  console.log(
    `Internal link check passed: ${pages.length} built pages, ${result.links.length} link results, ${strict.checked} strict HTML fragments.`,
  );
  return result;
}

export function parseBuildArgs(args) {
  const config = {};
  const flags = new Map([
    ["--base", "base"],
    ["--site", "site"],
    ["--outDir", "outDir"],
    ["--root", "root"],
    ["--config", "configFile"],
  ]);
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--") continue;
    const separator = argument.indexOf("=");
    const flag = separator === -1 ? argument : argument.slice(0, separator);
    const name = flags.get(flag);
    if (!name)
      throw new Error(
        `Unsupported docs build argument: ${argument}. Supported flags: ${[...flags.keys()].join(", ")}`,
      );
    const value = separator === -1 ? args[++index] : argument.slice(separator + 1);
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    config[name] = value;
  }
  return config;
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
    await buildAndCheck(parseBuildArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
