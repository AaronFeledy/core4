export const BACKDROP_RECIPE_ID = "backdrop";

export const backdropRecipeSource = `${BACKDROP_RECIPE_ID}/recipe.yml`;

export const backdropRecipeYaml = `id: ${BACKDROP_RECIPE_ID}
title: Backdrop
description: Backdrop CMS with Apache PHP and MariaDB.
version: 0.1.0
authors:
  - Lando Core Team
tags:
  - backdrop
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
    text: Run 'lando start' inside the new app directory to bring Backdrop up.
`;
