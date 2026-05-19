export const DJANGO_RECIPE_ID = "django";

export const djangoRecipeSource = `${DJANGO_RECIPE_ID}/recipe.yml`;

export const djangoRecipeYaml = `id: ${DJANGO_RECIPE_ID}
title: Django
description: Django with PostgreSQL, Redis, and an optional Celery worker.
version: 0.1.0
authors:
  - Lando Core Team
tags:
  - django
  - python
prompts:
  - name: name
    type: text
    message: App name
    validate:
      pattern: ^[a-z][a-z0-9-]*$
      message: App name must be lowercase kebab-case.
  - name: celery
    type: confirm
    message: Add a Celery worker service?
    default: false
files:
  - src: templates/.lando.yml.tmpl
    dest: .lando.yml
    template: true
postInit:
  - type: message
    text: Run 'lando start' inside the new app directory to bring Django up.
`;
