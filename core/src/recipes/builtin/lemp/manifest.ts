export const LEMP_RECIPE_ID = "lemp";

export const lempRecipeSource = `${LEMP_RECIPE_ID}/recipe.yml`;

export const lempRecipeYaml = `id: ${LEMP_RECIPE_ID}
title: LEMP Starter
description: Generic LEMP starter with nginx, PHP, and MariaDB.
version: 0.1.0
authors:
  - Lando Core Team
tags:
  - lemp
  - php
  - nginx
  - mariadb
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
files:
  - src: templates/.lando.yml.tmpl
    dest: .lando.yml
    template: true
postInit:
  - type: message
    text: Run 'lando start' inside the new app directory to bring the LEMP stack up.
`;
