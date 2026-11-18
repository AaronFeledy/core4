package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

type contribComposerManifest struct {
	Name       string            `json:"name"`
	Require    map[string]string `json:"require"`
	RequireDev map[string]string `json:"require-dev"`
}

func readContribComposer(root string) (contribComposerManifest, error) {
	var manifest contribComposerManifest
	path := filepath.Join(root, "composer.json")
	data, err := os.ReadFile(path)
	if err != nil {
		return manifest, err
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		return manifest, fmt.Errorf("Could not read %s: %w", path, err)
	}
	return manifest, nil
}

func contribComposerRequire(streams helperIO, dir string, dev bool, packages ...string) error {
	args := []string{"--working-dir=" + dir, "require"}
	if dev {
		args = append(args, "--dev")
	}
	args = append(args, "--no-update", "--no-interaction")
	if err := streams.runCommand(dir, "composer", append(args, packages...)...); err != nil {
		return fmt.Errorf("Composer could not require packages in %s: %w", dir, err)
	}
	return nil
}

func stageDrupalContrib(s *scaffold, stage string, o drupalContribOptions) error {
	if err := s.runCommand(s.appRoot, "composer", "create-project", "--no-install", "--no-scripts", "--no-interaction",
		"drupal/recommended-project:"+o.constraint, stage); err != nil {
		return fmt.Errorf("Drupal contrib scaffold could not stage the project: %w", err)
	}
	if !isRegularFile(filepath.Join(stage, "composer.json")) {
		return errors.New("Drupal contrib scaffold did not stage a composer.json.")
	}
	if err := mergeContribDependencies(s, stage, o); err != nil {
		return err
	}
	site, err := readContribComposer(stage)
	if err != nil {
		return err
	}
	declared := site.declaredPackages()
	if !declared["drush/drush"] {
		if err := contribComposerRequire(s.streams, stage, false, "drush/drush:*"); err != nil {
			return err
		}
	}
	dev := []string{"drupal/core-dev:" + o.constraint}
	if !declared["drupal/coder"] {
		dev = append(dev, "drupal/coder:*")
	}
	if err := contribComposerRequire(s.streams, stage, true, dev...); err != nil {
		return err
	}
	// The recommended project ships a lock for its own requirements. Resolve the
	// whole site here so a dependency conflict fails before anything is promoted,
	// and the install in the app root runs from a lock that matches composer.json.
	if err := s.runCommand(s.appRoot, "composer", "--working-dir="+stage, "update",
		"--no-install", "--no-scripts", "--no-plugins", "--no-interaction"); err != nil {
		return fmt.Errorf("Drupal contrib scaffold could not resolve the site dependencies: %w", err)
	}
	return nil
}

func (site contribComposerManifest) declaredPackages() map[string]bool {
	declared := make(map[string]bool, len(site.Require)+len(site.RequireDev))
	for _, bucket := range []map[string]string{site.Require, site.RequireDev} {
		for name := range bucket {
			declared[strings.ToLower(name)] = true
		}
	}
	return declared
}

// mergeContribDependencies adds the extension's own require and require-dev
// entries to the staged site, so its tests run against what it declares.
func mergeContribDependencies(s *scaffold, stage string, o drupalContribOptions) error {
	extension, err := readContribComposer(o.extensionPath("custom"))
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	site, err := readContribComposer(stage)
	if err != nil {
		return err
	}
	seen := site.declaredPackages()
	for _, bucket := range []struct {
		dev          bool
		dependencies map[string]string
	}{{false, extension.Require}, {true, extension.RequireDev}} {
		var packages []string
		for name, version := range bucket.dependencies {
			key := strings.ToLower(name)
			if skipContribDependency(key, extension.Name) || seen[key] {
				continue
			}
			if !contribPackagePattern.MatchString(name) {
				return fmt.Errorf("Invalid Composer package name in the extension's dependencies: %q", name)
			}
			seen[key] = true
			packages = append(packages, name+":"+version)
		}
		sort.Strings(packages)
		if len(packages) > 0 {
			if err := contribComposerRequire(s.streams, stage, bucket.dev, packages...); err != nil {
				return err
			}
		}
	}
	return nil
}

var contribPackagePattern = regexp.MustCompile(`(?i)^[a-z0-9][a-z0-9_.-]*(/[a-z0-9][a-z0-9_.-]*)?$`)

func skipContribDependency(name, self string) bool {
	// Platform requirements follow the recipe's PHP choice. Skip core requirements
	// so maintainers can test against a core version the extension does not declare yet.
	switch name {
	case "php", "composer-plugin-api", "composer-runtime-api", "drupal/core", "drupal/core-recommended", "drupal/core-dev", "drupal/core-composer-scaffold", "drupal/core-project-message":
		return true
	}
	return strings.EqualFold(name, self) || strings.HasPrefix(name, "ext-") || strings.HasPrefix(name, "lib-")
}
