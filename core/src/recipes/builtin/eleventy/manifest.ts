export const ELEVENTY_RECIPE_ID = "eleventy";

export const eleventyRecipeSource = `${ELEVENTY_RECIPE_ID}/recipe.yml`;

export const eleventyRecipeYaml = `id: ${ELEVENTY_RECIPE_ID}
title: Eleventy
description: Eleventy static site with a Node-based build helper and an nginx static frontend.
version: 0.1.0
authors:
  - Lando Core Team
tags:
  - eleventy
  - static
  - node
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
    text: Run 'lando start' inside the new app directory to serve the Eleventy site.
`;
