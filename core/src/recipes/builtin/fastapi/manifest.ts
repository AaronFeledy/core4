export const FASTAPI_RECIPE_ID = "fastapi";

export const fastapiRecipeSource = `${FASTAPI_RECIPE_ID}/recipe.yml`;

export const fastapiRecipeYaml = `id: ${FASTAPI_RECIPE_ID}
title: FastAPI
description: FastAPI with PostgreSQL and Redis.
version: 0.1.0
authors:
  - Lando Core Team
tags:
  - fastapi
  - python
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
    text: Run 'lando start' inside the new app directory to bring FastAPI up.
`;
