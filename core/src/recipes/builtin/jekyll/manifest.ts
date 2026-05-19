export const JEKYLL_RECIPE_ID = "jekyll";

export const jekyllRecipeSource = `${JEKYLL_RECIPE_ID}/recipe.yml`;

export const jekyllRecipeYaml = `id: ${JEKYLL_RECIPE_ID}
title: Jekyll
description: Jekyll static site with a Ruby build service and an nginx static frontend.
version: 0.1.0
authors:
  - Lando Core Team
tags:
  - jekyll
  - ruby
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
    text: Run 'lando start' inside the new app directory to serve the Jekyll site.
`;
