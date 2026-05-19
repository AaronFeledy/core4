export const HUGO_RECIPE_ID = "hugo";

export const hugoRecipeSource = `${HUGO_RECIPE_ID}/recipe.yml`;

export const hugoRecipeYaml = `id: ${HUGO_RECIPE_ID}
title: Hugo
description: Hugo static site with a Node-based build helper and an nginx static frontend.
version: 0.1.0
authors:
  - Lando Core Team
tags:
  - hugo
  - static
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
    text: Run 'lando start' inside the new app directory to serve the Hugo site.
`;
