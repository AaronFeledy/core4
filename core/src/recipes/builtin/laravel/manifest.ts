import {
  DRUPAL_COMPOSER_OPTIONS,
  LARAVEL_DATABASES,
  composerPromptYaml,
  databasePromptYaml,
  phpPromptYaml,
  webrootPromptYaml,
} from "../php-stack";

export const LARAVEL_RECIPE_ID = "laravel";

export const laravelRecipeSource = `${LARAVEL_RECIPE_ID}/recipe.yml`;

export const laravelRecipeYaml = `id: ${LARAVEL_RECIPE_ID}
title: Laravel
description: Laravel with PHP, MariaDB or PostgreSQL, Redis, and an optional queue worker.
version: 0.1.0
authors:
  - Lando Core Team
tags:
  - laravel
  - php
prompts:
  - name: name
    type: text
    message: App name
    validate:
      pattern: ^[a-z][a-z0-9-]*$
      message: App name must be lowercase kebab-case.
${phpPromptYaml}
${databasePromptYaml(LARAVEL_DATABASES)}
${composerPromptYaml(DRUPAL_COMPOSER_OPTIONS)}
${webrootPromptYaml("/app/public")}
  - name: worker
    type: confirm
    message: Add a queue worker service?
    default: false
files:
  - src: templates/.lando.yml.tmpl
    dest: .lando.yml
    template: true
postInit:
  - type: message
    text: Run 'lando start' inside the new app directory to bring Laravel up.
`;
