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

func (o drupalContribOptions) readExtensionComposer() (contribComposerManifest, error) {
	extension, err := readContribComposer(o.extensionPath("custom"))
	if errors.Is(err, fs.ErrNotExist) {
		return contribComposerManifest{}, nil
	}
	return extension, err
}

func (streams helperIO) contribComposerEdit(dir, step string, dev bool, packages []string) error {
	if len(packages) == 0 {
		return nil
	}
	sort.Strings(packages)
	args := []string{"--working-dir=" + dir, step}
	if dev {
		args = append(args, "--dev")
	}
	args = append(args, "--no-update", "--no-interaction")
	return streams.contribComposer(dir, step, append(args, packages...))
}

func (streams helperIO) contribComposer(dir, step string, args []string) error {
	if err := streams.runCommand(dir, "composer", args...); err != nil {
		return fmt.Errorf("Drupal contrib sync: Composer %s failed; fix the Composer error, then rerun lando drupal-contrib-sync: %w", step, err)
	}
	return nil
}

func stageDrupalContrib(s *scaffold, manifest *scaffoldManifest, o drupalContribOptions) error {
	stage := s.stageDir
	if err := s.streams.contribComposer(s.appRoot, "create-project", []string{"create-project", "--no-install", "--no-scripts", "--no-interaction",
		"drupal/recommended-project:" + o.constraint, stage}); err != nil {
		return err
	}
	if !isRegularFile(filepath.Join(stage, "composer.json")) {
		return errors.New("Drupal contrib sync did not stage a composer.json.")
	}
	site, err := readContribComposer(stage)
	if err != nil {
		return err
	}
	extension, err := o.readExtensionComposer()
	if err != nil {
		return err
	}
	desired, err := desiredContribRequirements(o.constraint, site, extension, contribSyncRecord{})
	if err != nil {
		return err
	}
	changes := planContribChanges(contribSyncRecord{}, desired, site)
	for _, dev := range []bool{false, true} {
		if err := s.streams.contribComposerEdit(stage, "require", dev, changes.require[dev]); err != nil {
			return err
		}
	}
	// Resolve the entire staged site before promotion; install uses this lock.
	if err := s.streams.contribComposer(s.appRoot, "update (resolve the site dependencies)", []string{"--working-dir=" + stage, "update",
		"--no-install", "--no-scripts", "--no-plugins", "--no-interaction"}); err != nil {
		return err
	}
	applied, err := json.Marshal(desired)
	if err != nil {
		return err
	}
	manifest.Applied = applied
	return nil
}

func (manifest contribComposerManifest) bucket(dev bool) map[string]string {
	if dev {
		return manifest.RequireDev
	}
	return manifest.Require
}

func (manifest contribComposerManifest) declares(name string) bool {
	for _, bucket := range []map[string]string{manifest.Require, manifest.RequireDev} {
		for declared := range bucket {
			if strings.EqualFold(declared, name) {
				return true
			}
		}
	}
	return false
}

// desiredContribRequirements is the managed set: core at the constraint, the
// extension's own requirements, and Drush and Coder where the extension names
// neither. A package the site already declares without the previous sync
// having added it belongs to the site, as the recommended project's own
// requirements and anything added with lando composer do, and keeps its
// constraint.
func desiredContribRequirements(constraint string, site, extension contribComposerManifest, previous contribSyncRecord) (contribSyncRecord, error) {
	desired := contribSyncRecord{
		Version:    1,
		Require:    map[string]string{"drupal/core-recommended": constraint},
		RequireDev: map[string]string{"drupal/core-dev": constraint},
	}
	for _, name := range []string{"drupal/core-composer-scaffold", "drupal/core-project-message"} {
		if _, declared := site.Require[name]; declared {
			desired.Require[name] = constraint
		}
	}
	seen := make(map[string]bool)
	for _, dev := range []bool{false, true} {
		for name, version := range extension.bucket(dev) {
			key := strings.ToLower(name)
			if skipContribDependency(key, extension.Name) || seen[key] {
				continue
			}
			if !contribPackagePattern.MatchString(name) {
				return contribSyncRecord{}, fmt.Errorf("Invalid Composer package name in the extension's dependencies: %q", name)
			}
			seen[key] = true
			if site.declares(key) && !previous.manages(key) {
				continue
			}
			desired.bucket(dev)[key] = version
		}
	}
	if !seen["drush/drush"] {
		desired.Require["drush/drush"] = "*"
	}
	if !seen["drupal/coder"] {
		desired.RequireDev["drupal/coder"] = "*"
	}
	return desired, nil
}

var contribPackagePattern = regexp.MustCompile(`(?i)^[a-z0-9][a-z0-9_.-]*(/[a-z0-9][a-z0-9_.-]*)?$`)

func isManagedContribCore(name string) bool {
	switch name {
	case "drupal/core-recommended", "drupal/core-dev", "drupal/core-composer-scaffold", "drupal/core-project-message":
		return true
	}
	return false
}

func skipContribDependency(name, self string) bool {
	// Platform requirements follow the recipe's PHP choice. The recipe also
	// controls core so maintainers can test versions the extension doesn't declare.
	switch name {
	case "php", "composer-plugin-api", "composer-runtime-api", "drupal/core":
		return true
	}
	return isManagedContribCore(name) || strings.EqualFold(name, self) || strings.HasPrefix(name, "ext-") || strings.HasPrefix(name, "lib-")
}
