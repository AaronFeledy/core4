import { readFile } from "node:fs/promises";

import { defineCollection } from "astro:content";
import { docsSchema } from "@astrojs/starlight/schema";
import { type DataStore, type Loader, type LoaderContext, type ParseDataOptions, glob } from "astro/loaders";
import { z } from "astro/zod";

import { deriveDescription, deriveTitle } from "./lib/titles.ts";

export const docsPatterns = [
  "reference/**/*.mdx",
  "contributing/*.md",
  "telemetry/*.md",
  "*.md",
  "guides/**/*.mdx",
  "!src/**",
  "!dist/**",
  "!node_modules/**",
  "!.astro/**",
] as const;

const RECIPE_PATTERN = "*/README.mdx";
const RECIPE_ID_PREFIX = "recipes/";
const GUIDES_ENABLED = process.env.LANDO_DOCS_GUIDES_ENABLED !== "0";

type AssetDataStore = DataStore & {
  readonly addAssetImport: (assetImport: string, filePath?: string) => void;
  readonly addAssetImports: (assetImports: string[], filePath?: string) => void;
};

const hasAssetMethods = (store: DataStore): store is AssetDataStore =>
  "addAssetImport" in store &&
  typeof store.addAssetImport === "function" &&
  "addAssetImports" in store &&
  typeof store.addAssetImports === "function";

const scopedStore = (store: DataStore, includesId: (id: string) => boolean): AssetDataStore => {
  if (!hasAssetMethods(store)) {
    throw new TypeError("Astro content store does not expose asset import methods.");
  }

  return {
    get: <TData extends Record<string, unknown> = Record<string, unknown>>(key: string) =>
      includesId(key) ? store.get<TData>(key) : undefined,
    entries: () => store.entries().filter(([id]) => includesId(id)),
    values: () => store.values().filter((entry) => includesId(entry.id)),
    keys: () => store.keys().filter(includesId),
    set: (entry) => store.set(entry),
    delete: (key) => {
      if (includesId(key)) store.delete(key);
    },
    clear: () => {
      for (const key of store.keys().filter(includesId)) store.delete(key);
    },
    has: (key) => includesId(key) && store.has(key),
    addAssetImport: (assetImport, filePath) => store.addAssetImport(assetImport, filePath),
    addAssetImports: (assetImports, filePath) => store.addAssetImports(assetImports, filePath),
    addModuleImport: (fileName) => store.addModuleImport(fileName),
  };
};

const withDerivedMetadata = (loader: Loader): Loader => ({
  name: `derived-${loader.name}`,
  load: async (context) => {
    const parseData: LoaderContext["parseData"] = async <TData extends Record<string, unknown>>(
      props: ParseDataOptions<TData>,
    ): Promise<TData> => {
      const source = props.filePath === undefined ? "" : await readFile(props.filePath, "utf8");
      const authoredTitle = props.data.title;
      const authoredDescription = props.data.description;
      const description = authoredDescription === undefined ? deriveDescription(source) : authoredDescription;
      const data = {
        ...props.data,
        title: authoredTitle === undefined ? deriveTitle(source, props.data, props.id) : authoredTitle,
        ...(description === undefined ? {} : { description }),
      };
      return context.parseData({ ...props, data });
    };

    await loader.load({ ...context, parseData });
  },
});

const docsLoader = withDerivedMetadata(
  glob({
    base: ".",
    pattern: docsPatterns.filter((pattern) => GUIDES_ENABLED || pattern !== "guides/**/*.mdx"),
  }),
);

const recipesLoader = withDerivedMetadata(
  glob({
    base: "../recipes",
    pattern: RECIPE_PATTERN,
    generateId: ({ entry }) => `${RECIPE_ID_PREFIX}${entry.replace(/\/README\.mdx$/, "")}`,
  }),
);

const isRecipeId = (id: string): boolean => id.startsWith(RECIPE_ID_PREFIX);
const isDocsId = (id: string): boolean => !isRecipeId(id);

const publicDocsLoader = {
  name: "lando-public-docs",
  load: async (context) => {
    await docsLoader.load({ ...context, store: scopedStore(context.store, isDocsId) });
    await recipesLoader.load({ ...context, store: scopedStore(context.store, isRecipeId) });
  },
} satisfies Loader;

const guidePlatform = z.enum(["darwin", "linux", "win32", "wsl"]);
const guideSkip = z.object({
  reason: z.string(),
  until: z.string().optional(),
});
const guideVariant = z.object({
  skip: guideSkip.optional(),
  tags: z.array(z.string()).optional(),
  platforms: z.array(guidePlatform).optional(),
});
const guideFrontmatter = z.object({
  id: z.string().optional(),
  defaultLayer: z.enum(["scenario", "e2e"]).optional(),
  provider: z.literal("test").optional(),
  timeout: z.number().int().positive().optional(),
  platforms: z.array(guidePlatform).optional(),
  tags: z.array(z.string()).optional(),
  tabs: z.array(z.string()).min(1).optional(),
  axes: z.record(z.string(), z.array(z.string()).min(1)).optional(),
  variants: z.record(z.string(), guideVariant).optional(),
  skip: guideSkip.optional(),
  deprecated: z
    .object({
      since: z.string(),
      removeIn: z.string().optional(),
      severity: z.enum(["info", "warn", "error"]).optional(),
      replacement: z.string().optional(),
      note: z.string(),
      docsUrl: z.url().optional(),
      ticket: z.string().optional(),
    })
    .optional(),
});

export const collections = {
  docs: defineCollection({
    loader: publicDocsLoader,
    schema: docsSchema({ extend: guideFrontmatter }),
  }),
} as const;
