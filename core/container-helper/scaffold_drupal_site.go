package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

type drupalSiteIntent struct {
	Webroot string `json:"webroot"`
	Major   string `json:"major,omitempty"`
	Testing bool   `json:"testing"`
}

var drupalSiteSegment = regexp.MustCompile(`^[A-Za-z0-9_-](?:[A-Za-z0-9_.-]*[A-Za-z0-9_-])?$`)
var drupalWindowsDevice = regexp.MustCompile(`^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)`)
var errDrupalSiteArgs = errors.New("expected <webroot> and --testing=<bool> (true or false)")

const drupalScaffoldUsage = "lando-drupal-scaffold <major> <webroot> --testing=<bool>"
const drupalCmsScaffoldUsage = "lando-drupal-cms-scaffold <webroot> --testing=<bool>"

func reportDrupalScaffoldUsage(streams helperIO, task string, usage string) int {
	fmt.Fprintf(streams.stderr, "Usage: %s\nUpdate the %s task cmd in .lando.yml to use this form.\n", usage, task)
	return 64
}

func parseDrupalSiteIntent(args []string, major string) (drupalSiteIntent, error) {
	if len(args) != 2 || (args[1] != "--testing=true" && args[1] != "--testing=false") {
		return drupalSiteIntent{}, errDrupalSiteArgs
	}
	root := strings.TrimPrefix(args[0], "/app/")
	lowerRoot := strings.ToLower(root)
	switch lowerRoot {
	case "vendor", "recipes", "drush", "node_modules", "tmp", "composer.json", "composer.lock", "phpcs.xml.dist", "phpstan.neon.dist":
		root = ""
	}
	if !drupalSiteSegment.MatchString(root) || drupalWindowsDevice.MatchString(lowerRoot) {
		return drupalSiteIntent{}, fmt.Errorf("cannot scaffold into webroot %q: set recipe.options.webroot in .lando.yml to one directory name such as web or docroot, then restart the app", args[0])
	}
	return drupalSiteIntent{Webroot: root, Major: major, Testing: args[1] == "--testing=true"}, nil
}

func (i drupalSiteIntent) requiredOutputs() []string {
	required := []string{"composer.json", "composer.lock", "vendor", i.Webroot}
	if i.Major == "" {
		required = append(required, "recipes")
	}
	return required
}

func (i drupalSiteIntent) complete(root string) bool {
	return isRegularFile(filepath.Join(root, "composer.json")) &&
		isRegularFile(filepath.Join(root, "composer.lock")) &&
		executableFile(filepath.Join(root, "vendor", "bin", "drush")) &&
		isRegularFile(filepath.Join(root, i.Webroot, "index.php")) &&
		isDirectory(filepath.Join(root, i.Webroot, "core")) &&
		(i.Major != "" || isRegularFile(filepath.Join(root, "recipes", "drupal_cms_starter", "recipe.yml")))
}

func (i drupalSiteIntent) options(s *scaffold, generate func(string, *scaffoldManifest) error) scaffoldOptions {
	required := i.requiredOutputs()
	return scaffoldOptions{
		siteIntent:      &i,
		requiredOutputs: required,
		generate:        generate,
		complete:        i.complete,
		afterPromote: func(_ *scaffoldManifest) error {
			if i.Testing {
				return s.prepareDrupalTestDirs(i.Webroot)
			}
			return nil
		},
		preflight: func(resumed bool, _ *scaffoldManifest) error {
			if resumed {
				return nil
			}
			for _, name := range required {
				path := filepath.Join(s.appRoot, name)
				info, err := os.Lstat(path)
				if errors.Is(err, fs.ErrNotExist) {
					continue
				}
				if err != nil {
					return err
				}
				if info.IsDir() && name != "composer.json" && name != "composer.lock" && dirIsEmpty(path) {
					continue
				}
				return fmt.Errorf("%s already exists; scaffold only generates new projects and did not change this checkout", path)
			}
			return nil
		},
	}
}
