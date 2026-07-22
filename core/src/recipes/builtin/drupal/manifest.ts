export const DRUPAL_RECIPE_ID = "drupal";

export const drupalRecipeSource = `${DRUPAL_RECIPE_ID}/recipe.yml`;

export const drupalRecipeYaml = `id: ${DRUPAL_RECIPE_ID}
title: Drupal
description: Drupal 11 with PHP, a database (MariaDB or PostgreSQL), and Drush.
version: 0.1.0
authors:
  - Lando Core Team
tags:
  - drupal
  - php
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
      - value: '8.3'
  - name: database
    type: select
    message: Database engine
    default: mariadb
    choices:
      - value: mariadb
      - value: postgres
files:
  - src: templates/.lando.yml.tmpl
    dest: .lando.yml
    template: true
postInit:
  - type: message
    text: Run 'lando start', then scaffold Drupal 11 with 'lando drupal-scaffold'.
`;
