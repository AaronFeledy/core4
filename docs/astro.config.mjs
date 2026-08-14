import mdx from "@astrojs/mdx";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

import { escapeReferenceMdxPlaceholders } from "./src/reference-mdx.ts";
import { sidebar } from "./src/sidebar.ts";

const REFERENCE_MDX_PATTERN = /\/docs\/reference\/.*\.mdx$/;

export default defineConfig({
  integrations: [
    starlight({
      title: "Lando",
      sidebar: [...sidebar],
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
