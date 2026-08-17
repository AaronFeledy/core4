import { unified } from "@astrojs/markdown-remark";
import mdx from "@astrojs/mdx";
import starlight from "@astrojs/starlight";
import AutoImport from "astro-auto-import";
import { defineConfig } from "astro/config";

import { guideComponentVocabulary } from "./src/components/vocabulary.ts";
import { remarkDropLeadingHeading } from "./src/plugins/remark-drop-leading-heading.ts";
import { remarkGuideContext } from "./src/plugins/remark-guide-context.ts";
import { escapeReferenceMdxPlaceholders } from "./src/reference-mdx.ts";
import { sidebar } from "./src/sidebar.ts";

const REFERENCE_MDX_PATTERN = /\/docs\/reference\/.*\.mdx$/;

export default defineConfig({
  site: "https://aaronfeledy.github.io",
  base: "/core4/",
  markdown: {
    processor: unified({ remarkPlugins: [remarkGuideContext, remarkDropLeadingHeading] }),
  },
  integrations: [
    starlight({
      title: "Lando",
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
