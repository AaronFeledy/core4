import {
  DRUPAL_DATABASES,
  composerPromptYaml,
  databasePromptYaml,
  phpPromptYaml,
  webrootPromptYaml,
  webserverPromptYaml,
} from "../php-stack";

export const DRUPAL_RECIPE_ID = "drupal";

export const drupalRecipeSource = `${DRUPAL_RECIPE_ID}/recipe.yml`;

export const drupalRecipeYaml = `id: ${DRUPAL_RECIPE_ID}
title: Drupal
description: Drupal with PHP, a database, and project-local Drush.
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
  - name: drupal
    type: select
    message: Drupal major version
    default: '11'
    choices:
      - value: '11'
      - value: '10'
${phpPromptYaml}
${webserverPromptYaml}
${databasePromptYaml(DRUPAL_DATABASES)}
${composerPromptYaml}
${webrootPromptYaml("/app/web")}
files:
  - src: templates/.lando.yml.tmpl
    dest: .lando.yml
    template: true
postInit:
  - type: message
    text: Run 'lando start', then scaffold Drupal and project-local Drush with 'lando drupal-scaffold'.
`;
