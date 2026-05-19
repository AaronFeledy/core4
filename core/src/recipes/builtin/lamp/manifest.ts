export const LAMP_RECIPE_ID = "lamp";

export const lampRecipeSource = `${LAMP_RECIPE_ID}/recipe.yml`;

export const lampRecipeYaml = `id: ${LAMP_RECIPE_ID}
title: LAMP Starter
description: Generic LAMP starter with Apache, PHP, and MariaDB.
version: 0.1.0
authors:
  - Lando Core Team
tags:
  - lamp
  - php
  - apache
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
    text: Run 'lando start' inside the new app directory to bring the LAMP stack up.
`;
