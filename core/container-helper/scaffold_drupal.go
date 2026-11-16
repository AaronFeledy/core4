package main

import (
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
)

var drupalMajorPattern = regexp.MustCompile(`^[0-9]+$`)

// runDrupalScaffold implements `lando drupal-scaffold [<major>]`.
func runDrupalScaffold(args []string, streams helperIO, crash func(string)) int {
	major := ""
	for _, argument := range args {
		if strings.HasPrefix(argument, "-") {
			fmt.Fprintf(streams.stderr, "drupal-scaffold does not accept the option %s.\n", argument)
			return 1
		}
		if major != "" {
			fmt.Fprintln(streams.stderr, "drupal-scaffold accepts one Drupal major version argument.")
			return 1
		}
		major = argument
	}
	if major == "" {
		major = envValue(streams.env, "LANDO_DRUPAL_MAJOR")
	}
	if major == "" {
		fmt.Fprintln(streams.stderr, "drupal-scaffold needs a Drupal major version, for example 11.")
		return 1
	}
	if !drupalMajorPattern.MatchString(major) {
		fmt.Fprintf(streams.stderr, "drupal-scaffold needs a numeric Drupal major version: %s\n", major)
		return 1
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
		"composer.json, vendor/bin/drush, and web/",
		appRoot,
		streams,
		crash,
	)
	err := s.execute(scaffoldOptions{
		generate: func(stage string) error {
			if err := s.runCommand(
				appRoot,
				"composer",
				"create-project",
				"drupal/recommended-project:^"+major,
				stage,
			); err != nil {
				return fmt.Errorf("Drupal scaffold could not stage the project: %w", err)
			}
			if err := s.runCommand(
				appRoot,
				"composer",
				"--working-dir="+stage,
				"require",
				"drush/drush",
			); err != nil {
				return fmt.Errorf("Drupal scaffold could not install project-local Drush: %w", err)
			}
			if !isRegularFile(filepath.Join(stage, "composer.json")) {
				return errors.New("Drupal scaffold did not stage a composer.json.")
			}
			if !executableFile(filepath.Join(stage, "vendor", "bin", "drush")) {
				return errors.New("Drupal scaffold did not stage vendor/bin/drush.")
			}
			if !isDirectory(filepath.Join(stage, "web")) {
				return errors.New("Drupal scaffold did not stage web/.")
			}
			return nil
		},
		complete: drupalScaffoldComplete,
	})
	return scaffoldResult(s, err, streams)
}

func drupalScaffoldComplete(appRoot string) bool {
	return isRegularFile(filepath.Join(appRoot, "composer.json")) &&
		executableFile(filepath.Join(appRoot, "vendor", "bin", "drush")) &&
		isDirectory(filepath.Join(appRoot, "web"))
}
