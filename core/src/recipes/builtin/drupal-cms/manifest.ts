import {
  DRUPAL_DATABASES,
  composerPromptYaml,
  databasePromptYaml,
  phpPromptYaml,
  webrootPromptYaml,
  webserverPromptYaml,
} from "../php-stack";

export const DRUPAL_CMS_RECIPE_ID = "drupal-cms";

export const drupalCmsRecipeSource = `${DRUPAL_CMS_RECIPE_ID}/recipe.yml`;

export const drupalCmsRecipeYaml = `id: ${DRUPAL_CMS_RECIPE_ID}
title: Drupal CMS
description: Drupal CMS with PHP, a database, and project-local Drush.
version: 0.1.0
authors:
  - Lando Core Team
tags:
  - drupal
  - drupal-cms
  - php
  - mariadb
prompts:
  - name: name
    type: text
    message: App name
    validate:
      pattern: ^[a-z][a-z0-9-]*$
      message: App name must be lowercase kebab-case.
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
    text: Run 'lando start', then scaffold Drupal CMS with 'lando drupal-cms-scaffold', then install with 'lando drupal-cms-install'.
`;
