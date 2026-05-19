/**
 * Bundled `recipe.yml` for the built-in `node-ts` programmatic-Landofile
 * demonstration recipe.
 *
 * Embedded as a string so the compiled `$bunfs` binary does not need a
 * runtime filesystem read.
 *
 * The recipe writes a `.lando.ts` file instead of a `.lando.yml` so an
 * advanced recipe author can ship a programmatic Landofile that adapts
 * to `process.env` at parse time. The emitted module uses only the
 * documented `LandofileContext` inputs (`env`); it does not import any
 * forbidden node builtin, URL-scheme module, or relative path outside
 * the app root, so the `LandofileService` TS loader sandbox accepts it
 * verbatim.
 */
export const NODE_TS_RECIPE_ID = "node-ts";

export const nodeTsRecipeSource = `${NODE_TS_RECIPE_ID}/recipe.yml`;

export const nodeTsRecipeYaml = `id: ${NODE_TS_RECIPE_ID}
title: Node + programmatic Landofile
description: Advanced demo that emits a programmatic .lando.ts Landofile instead of .lando.yml.
version: 0.1.0
authors:
  - Lando Core Team
tags:
  - node
  - programmatic
  - typescript
prompts:
  - name: name
    type: text
    message: App name
    validate:
      pattern: ^[a-z][a-z0-9-]*$
      message: App name must be lowercase kebab-case.
files:
  - src: templates/.lando.ts.tmpl
    dest: .lando.ts
    template: true
postInit:
  - type: message
    text: Open .lando.ts to customize the programmatic Landofile before running 'lando start'.
`;
