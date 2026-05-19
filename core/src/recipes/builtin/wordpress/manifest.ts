export const WORDPRESS_RECIPE_ID = "wordpress";

export const wordpressRecipeSource = `${WORDPRESS_RECIPE_ID}/recipe.yml`;

export const wordpressRecipeYaml = `id: ${WORDPRESS_RECIPE_ID}
title: WordPress
description: WordPress with PHP, MariaDB, and an optional Redis cache.
version: 0.1.0
authors:
  - Lando Core Team
tags:
  - wordpress
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
      - value: '8.2'
        label: PHP 8.2
      - value: '8.3'
        label: PHP 8.3
  - name: redis
    type: confirm
    message: Add a Redis cache service?
    default: false
files:
  - src: templates/.lando.yml.tmpl
    dest: .lando.yml
    template: true
postInit:
  - type: message
    text: Run 'lando start' inside the new app directory to bring WordPress up.
`;
