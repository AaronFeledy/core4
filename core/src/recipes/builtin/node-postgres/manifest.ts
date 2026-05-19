/**
 * Bundled `recipe.yml` for the built-in `node-postgres` scaffold.
 *
 * Embedded as a string so the compiled `$bunfs` binary does not need a
 * runtime filesystem read.
 */
export const NODE_POSTGRES_RECIPE_ID = "node-postgres";

export const nodePostgresRecipeSource = `${NODE_POSTGRES_RECIPE_ID}/recipe.yml`;

export const nodePostgresRecipeYaml = `id: ${NODE_POSTGRES_RECIPE_ID}
title: Node + Postgres
description: Minimal Node.js + Postgres scaffold for the Alpha walking skeleton.
version: 0.1.0
authors:
  - Lando Core Team
tags:
  - node
  - postgres
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
  - src: templates/package.json.tmpl
    dest: package.json
    template: true
  - src: assets/server.js
    dest: server.js
    template: false
postInit:
  - type: message
    text: Run 'lando start' inside the new app directory to bring it up.
`;
