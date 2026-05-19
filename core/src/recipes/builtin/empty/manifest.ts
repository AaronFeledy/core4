export const EMPTY_RECIPE_ID = "empty";

export const emptyRecipeSource = `${EMPTY_RECIPE_ID}/recipe.yml`;

export const emptyRecipeYaml = `id: ${EMPTY_RECIPE_ID}
title: Empty Landofile
description: Blank Landofile starter with no service opinion — pick services manually.
version: 0.1.0
authors:
  - Lando Core Team
tags:
  - starter
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
    text: Edit the generated .lando.yml to declare services for your stack.
`;
