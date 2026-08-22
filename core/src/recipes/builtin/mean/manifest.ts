export const MEAN_RECIPE_ID = "mean";

export const meanRecipeSource = `${MEAN_RECIPE_ID}/recipe.yml`;

export const meanRecipeYaml = `id: ${MEAN_RECIPE_ID}
title: MEAN
description: MEAN-style Node API with MongoDB and optional Redis.
version: 0.1.0
authors:
  - Lando Core Team
tags:
  - mean
  - node
  - mongodb
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
  - name: redis
    type: confirm
    message: Add a Redis cache service?
    default: false
files:
  - src: templates/.lando.yml.tmpl
    dest: .lando.yml
    template: true
  - src: templates/package.json.tmpl
    dest: package.json
    template: true
  - src: templates/server.js.tmpl
    dest: server.js
    template: true
postInit:
  - type: message
    text: Run 'lando start' inside the new app directory to bring the MEAN stack up.
`;
