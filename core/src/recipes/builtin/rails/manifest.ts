export const RAILS_RECIPE_ID = "rails";

export const railsRecipeSource = `${RAILS_RECIPE_ID}/recipe.yml`;

export const railsRecipeYaml = `id: ${RAILS_RECIPE_ID}
title: Ruby on Rails
description: Ruby on Rails with PostgreSQL and Redis.
version: 0.1.0
authors:
  - Lando Core Team
tags:
  - rails
  - ruby
prompts:
  - name: name
    type: text
    message: App name
    validate:
      pattern: ^[a-z][a-z0-9-]*$
      message: App name must be lowercase kebab-case.
files:
  - src: templates/.lando.yml.tmpl
    dest: .lando.yml
    template: true
postInit:
  - type: message
    text: Run 'lando start' inside the new app directory to bring Rails up.
`;
