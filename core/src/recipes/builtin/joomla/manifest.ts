export const JOOMLA_RECIPE_ID = "joomla";
export const joomlaRecipeSource = `${JOOMLA_RECIPE_ID}/recipe.yml`;
export const joomlaRecipeYaml = `id: ${JOOMLA_RECIPE_ID}
title: Joomla
description: Joomla with Apache PHP and MariaDB.
version: 0.1.0
authors:
  - Lando Core Team
tags:
  - joomla
  - php
  - apache
  - mariadb
extends: lamp
files:
  - src: templates/.lando.yml.tmpl
    dest: .lando.yml
    template: true
postInit:
  - type: message
    text: Run 'lando start' inside the new app directory to bring Joomla up.
`;
