import { defineCollection } from "astro:content";
import { docsSchema } from "@astrojs/starlight/schema";
import { glob } from "astro/loaders";

export const docsPatterns = ["reference/**/*.mdx"] as const;

export const collections = {
  docs: defineCollection({
    loader: glob({ base: ".", pattern: [...docsPatterns] }),
    schema: docsSchema(),
  }),
} as const;
