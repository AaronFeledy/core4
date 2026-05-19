export const SVELTEKIT_RECIPE_ID = "sveltekit";

export const sveltekitRecipeSource = `${SVELTEKIT_RECIPE_ID}/recipe.yml`;

export const sveltekitRecipeYaml = `id: ${SVELTEKIT_RECIPE_ID}
title: SvelteKit
description: SvelteKit frontend with an adapter picker and optional database.
version: 0.1.0
authors:
  - Lando Core Team
tags:
  - sveltekit
  - svelte
  - node
prompts:
  - name: name
    type: text
    message: App name
    validate:
      pattern: ^[a-z][a-z0-9-]*$
      message: App name must be lowercase kebab-case.
  - name: node
    type: select
    message: Node version
    default: lts
    choices:
      - value: lts
      - value: '22'
  - name: adapter
    type: select
    message: SvelteKit adapter
    default: node
    choices:
      - value: node
      - value: auto
  - name: database
    type: select
    message: Database
    default: none
    choices:
      - value: none
      - value: postgres
      - value: mariadb
files:
  - src: templates/.lando.yml.tmpl
    dest: .lando.yml
    template: true
postInit:
  - type: message
    text: Run 'lando start' inside the new app directory to bring SvelteKit up.
`;
