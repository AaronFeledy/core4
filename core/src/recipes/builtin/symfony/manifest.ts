export const SYMFONY_RECIPE_ID = "symfony";

export const symfonyRecipeSource = `${SYMFONY_RECIPE_ID}/recipe.yml`;

export const symfonyRecipeYaml = `id: ${SYMFONY_RECIPE_ID}
title: Symfony
description: Symfony with PHP, PostgreSQL or MariaDB, and Redis.
version: 0.1.0
authors:
  - Lando Core Team
tags:
  - symfony
  - php
prompts:
  - name: name
    type: text
    message: App name
    validate:
      pattern: ^[a-z][a-z0-9-]*$
      message: App name must be lowercase kebab-case.
  - name: php
    type: select
    message: PHP version
    default: '8.3'
    choices:
      - value: '8.2'
      - value: '8.3'
  - name: database
    type: select
    message: Database engine
    default: postgres
    choices:
      - value: postgres
      - value: mariadb
files:
  - src: templates/.lando.yml.tmpl
    dest: .lando.yml
    template: true
postInit:
  - type: message
    text: Run 'lando start' inside the new app directory to bring Symfony up.
`;
