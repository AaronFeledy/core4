import { nodeTsSnapshotYaml } from "./snapshot.ts";

/**
 * Bundled `recipe.yml` for the built-in `node-ts` environment-expression
 * demonstration recipe.
 *
 * Embedded as a string so the compiled `$bunfs` binary does not need a
 * runtime filesystem read.
 *
 * The init pipeline emits a canonical `.lando.yml` whose expressions read the
 * documented environment scope when the Landofile is loaded.
 */
export const NODE_TS_RECIPE_ID = "node-ts";

export const nodeTsRecipeSource = `${NODE_TS_RECIPE_ID}/recipe.yml`;

export const nodeTsRecipeYaml = `id: ${NODE_TS_RECIPE_ID}
title: Node + environment expressions
description: Node service whose canonical Landofile reads image and environment defaults from the host environment.
version: 0.1.0
authors:
  - Lando Core Team
tags:
  - node
  - expressions
  - typescript
prompts:
  - name: name
    type: text
    message: App name
    validate:
      pattern: ^[a-z][a-z0-9-]*$
      message: App name must be lowercase kebab-case.
files:
  - src: templates/.lando.yml.tmpl
    dest: .lando.yml
    template: true
postInit:
  - type: message
    text: Open the generated Landofile to customize its environment expressions before running 'lando start'.

${nodeTsSnapshotYaml}
`;
