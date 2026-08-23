import {
  DRUPAL_COMPOSER_OPTIONS,
  SYMFONY_DATABASES,
  composerPromptYaml,
  databasePromptYaml,
  phpPromptYaml,
  webrootPromptYaml,
} from "../php-stack";

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
${phpPromptYaml}
${databasePromptYaml(SYMFONY_DATABASES)}
${composerPromptYaml(DRUPAL_COMPOSER_OPTIONS)}
${webrootPromptYaml("/app/public")}
files:
  - src: templates/.lando.yml.tmpl
    dest: .lando.yml
    template: true
postInit:
  - type: message
    text: Run 'lando start' inside the new app directory to bring Symfony up.
`;
