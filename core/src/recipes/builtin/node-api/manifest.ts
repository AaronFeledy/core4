export const NODE_API_RECIPE_ID = "node-api";

export const nodeApiRecipeSource = `${NODE_API_RECIPE_ID}/recipe.yml`;

export const nodeApiRecipeYaml = `id: ${NODE_API_RECIPE_ID}
title: Node API
description: Node API with an Express, Fastify, or Hono framework picker and an optional Postgres database.
version: 0.1.0
authors:
  - Lando Core Team
tags:
  - node
  - api
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
  - name: framework
    type: select
    message: API framework
    default: express
    choices:
      - value: express
      - value: fastify
      - value: hono
  - name: database
    type: select
    message: Database
    default: postgres
    choices:
      - value: postgres
      - value: none
files:
  - src: templates/.lando.yml.tmpl
    dest: .lando.yml
    template: true
postInit:
  - type: message
    text: Run 'lando start' inside the new app directory to bring the Node API up.
`;
