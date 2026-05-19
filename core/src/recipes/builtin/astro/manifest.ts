export const ASTRO_RECIPE_ID = "astro";

export const astroRecipeSource = `${ASTRO_RECIPE_ID}/recipe.yml`;

export const astroRecipeYaml = `id: ${ASTRO_RECIPE_ID}
title: Astro
description: Astro frontend with an optional content-source database picker.
version: 0.1.0
authors:
  - Lando Core Team
tags:
  - astro
  - node
  - frontend
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
  - name: database
    type: select
    message: Content-source database
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
    text: Run 'lando start' inside the new app directory to bring Astro up.
`;
