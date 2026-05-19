export const NEXTJS_RECIPE_ID = "nextjs";

export const nextjsRecipeSource = `${NEXTJS_RECIPE_ID}/recipe.yml`;

export const nextjsRecipeYaml = `id: ${NEXTJS_RECIPE_ID}
title: Next.js
description: Next.js frontend with optional database and Auth helper picker.
version: 0.1.0
authors:
  - Lando Core Team
tags:
  - nextjs
  - react
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
  - name: database
    type: select
    message: Database
    default: postgres
    choices:
      - value: none
      - value: postgres
      - value: mariadb
  - name: auth
    type: select
    message: Auth helper
    default: none
    choices:
      - value: none
      - value: nextauth
      - value: clerk
files:
  - src: templates/.lando.yml.tmpl
    dest: .lando.yml
    template: true
postInit:
  - type: message
    text: Run 'lando start' inside the new app directory to bring Next.js up.
`;
