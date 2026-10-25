import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { unified } from "@astrojs/markdown-remark";
import mdx from "@astrojs/mdx";
import starlight from "@astrojs/starlight";
import AutoImport from "astro-auto-import";
import { defineConfig } from "astro/config";

import { writeLlmsFiles } from "./src/lib/llms.ts";
import { createSourceLinkInventory, publishSchemaAssets } from "./src/lib/source-links.ts";
import { remarkSourceLinks } from "./src/plugins/remark-source-links.ts";

import { guideComponentVocabulary } from "./src/components/vocabulary.ts";
import { remarkDropLeadingHeading } from "./src/plugins/remark-drop-leading-heading.ts";
import { remarkGuideContext } from "./src/plugins/remark-guide-context.ts";
import { escapeReferenceMdxPlaceholders } from "./src/reference-mdx.ts";
import { sidebar } from "./src/sidebar.ts";

const REFERENCE_MDX_PATTERN = /\/docs\/reference\/.*\.mdx$/;

const base = "/core4/";
let site;
const links = await createSourceLinkInventory(fileURLToPath(new URL("../", import.meta.url)), base);

export default defineConfig({
  site: "https://aaronfeledy.github.io",
  base,
  markdown: {
    processor: unified({
      remarkPlugins: [remarkGuideContext, remarkDropLeadingHeading, [remarkSourceLinks, links]],
    }),
  },
  integrations: [
    {
      name: "lando-schema-assets",
      hooks: {
        "astro:config:done": ({ config }) => {
          site = config.site;
        },
        "astro:build:start": () => {
          if (links.schemas.size === 0)
            throw new Error(
              "Generated schema assets are missing. Run bun run docs:build from the repository root.",
            );
        },
        "astro:build:done": async ({ dir }) => {
          await publishSchemaAssets(links, fileURLToPath(dir));
          await writeLlmsFiles(links, site, fileURLToPath(dir));
        },
      },
    },
    starlight({
      title: "Lando",
      logo: { src: "./src/assets/lando-logo.svg" },
      // Starlight prefixes `base` onto `favicon` but not onto raw head hrefs.
      head: [{ tag: "link", attrs: { rel: "icon", href: "/core4/favicon.ico", sizes: "32x32" } }],
      sidebar: [...sidebar],
    }),
    AutoImport({
      imports: Object.values(guideComponentVocabulary),
    }),
    mdx(),
  ],
  vite: {
    plugins: [
      {
        name: "lando-schema-assets-dev",
        configureServer(server) {
          const assets = new Map();
          for (const [source, asset] of links.schemas) {
            assets.set(`/${asset}`, source);
            assets.set(`${base}${asset}`, source);
          }
          server.middlewares.use(async (request, response, next) => {
            if (request.method !== "GET" && request.method !== "HEAD") return next();
            const source = assets.get(new URL(request.url ?? "/", "http://localhost").pathname);
            if (source === undefined) return next();
            try {
              const bytes = await readFile(source);
              response.setHeader("Content-Type", "application/json");
              response.end(request.method === "HEAD" ? undefined : bytes);
            } catch (error) {
              next(error);
            }
          });
        },
      },
      {
        name: "reference-mdx-placeholders",
        enforce: "pre",
        transform(source, id) {
          if (!REFERENCE_MDX_PATTERN.test(id)) return null;
          return escapeReferenceMdxPlaceholders(source);
        },
      },
    ],
  },
});
