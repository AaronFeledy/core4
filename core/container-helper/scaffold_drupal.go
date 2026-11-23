package main

import (
	"errors"
	"fmt"
	"regexp"
)

var drupalMajorPattern = regexp.MustCompile(`^[0-9]+$`)

func runDrupalScaffold(args []string, streams helperIO, crash func(string)) int {
	if len(args) == 0 || !drupalMajorPattern.MatchString(args[0]) {
		return reportDrupalScaffoldUsage(streams, drupalScaffoldUsage)
	}
	intent, err := parseDrupalSiteIntent(args[1:], args[0])
	if errors.Is(err, errDrupalSiteArgs) {
		return reportDrupalScaffoldUsage(streams, drupalScaffoldUsage)
	}
	appRoot := envValue(streams.env, "LANDO_DRUPAL_APP_ROOT")
	if appRoot == "" {
		appRoot = "/app"
	}
	s := newScaffold(
		"drupal-scaffold",
		"Drupal",
		"drupal-scaffold",
		fmt.Sprintf("Drupal is already scaffolded at %s.", appRoot),
		"",
		appRoot,
		streams,
		crash,
	)
	err = s.executeDrupalSite(intent, func(stage string, _ *scaffoldManifest) error {
		if err := s.runCommand(
			appRoot,
			"composer",
			"create-project",
			"drupal/recommended-project:^"+intent.Major,
			stage,
			"--no-install", "--no-scripts", "--no-interaction",
		); err != nil {
			return fmt.Errorf("Drupal scaffold could not stage the project: %w", err)
		}
		constraint, err := intent.prepareComposer(stage)
		if err != nil {
			return fmt.Errorf("Drupal scaffold could not prepare the Composer layout: %w", err)
		}
		if err := s.runCommand(appRoot, "composer", "--working-dir="+stage, "require", "--no-update", "drush/drush:^12.5 || ^13.8"); err != nil {
			return fmt.Errorf("Drupal scaffold could not declare Drush: %w", err)
		}
		if err := s.runCommand(appRoot, "composer", intent.devArgs(stage, constraint)...); err != nil {
			return fmt.Errorf("Drupal scaffold could not declare development tools: %w", err)
		}
		rootHook, err := composerScriptDefined(stage, "post-root-package-install")
		if err != nil {
			return err
		}
		if rootHook {
			if err := s.runCommand(appRoot, "composer", "--working-dir="+stage, "run-script", "post-root-package-install", "--no-interaction"); err != nil {
				return fmt.Errorf("Drupal scaffold could not run the post-root-package-install hook: %w", err)
			}
		}
		if err := s.runCommand(appRoot, "composer", "--working-dir="+stage, "update", "--no-interaction"); err != nil {
			return fmt.Errorf("Drupal scaffold could not install dependencies: %w", err)
		}
		if err := s.runCommand(appRoot, "composer", "--working-dir="+stage, "run-script", "post-create-project-cmd", "--no-interaction"); err != nil {
			return fmt.Errorf("Drupal scaffold could not run the post-create-project hook: %w", err)
		}
		return s.stageDrupalSiteFiles(stage, intent)
	})
	return scaffoldResult(err, streams)
}
