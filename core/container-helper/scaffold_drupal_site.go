package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
)

type drupalSiteIntent struct {
	Webroot string `json:"webroot"`
	Major   string `json:"major"`
	Testing bool   `json:"testing"`
	CMS     bool   `json:"cms,omitempty"`
}

var drupalSiteSegment = regexp.MustCompile(`^[A-Za-z0-9_-](?:[A-Za-z0-9_.-]*[A-Za-z0-9_-])?$`)
var drupalWindowsDevice = regexp.MustCompile(`^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)`)
var errDrupalSiteArgs = errors.New("expected <webroot> and --testing=<bool> (true or false)")

const drupalScaffoldUsage = "lando-drupal-scaffold <major> <webroot> --testing=<bool>"
const drupalCmsScaffoldUsage = "lando-drupal-cms-scaffold <webroot> --testing=<bool>"
const drupalCmsMajor = "2"

func reportDrupalScaffoldUsage(streams helperIO, usage string) int {
	fmt.Fprintf(streams.stderr, "Usage: %s\nScaffold tasks are no longer provided. Run lando start to scaffold a new Drupal site.\n", usage)
	return 64
}

func parseDrupalSiteIntent(args []string, major string) (drupalSiteIntent, error) {
	if len(args) != 2 || (args[1] != "--testing=true" && args[1] != "--testing=false") {
		return drupalSiteIntent{}, errDrupalSiteArgs
	}
	root := strings.TrimPrefix(args[0], "/app/")
	if args[0] == "/app" || args[0] == "/app/" {
		root = "."
	}
	return drupalSiteIntent{Webroot: root, Major: major, Testing: args[1] == "--testing=true"}, nil
}

func (i drupalSiteIntent) validateGenerationRoot() error {
	lowerRoot := strings.ToLower(i.Webroot)
	switch lowerRoot {
	case "vendor", "recipes", "drush", "node_modules", "tmp", "composer.json", "composer.lock", "phpcs.xml.dist", "phpstan.neon.dist":
		lowerRoot = ""
	}
	if lowerRoot == "" || !drupalSiteSegment.MatchString(i.Webroot) || drupalWindowsDevice.MatchString(lowerRoot) {
		return fmt.Errorf("cannot scaffold into webroot %q: set recipe.options.webroot in .lando.yml to one directory name such as web or docroot, then retry with lando start", i.Webroot)
	}
	return nil
}

func (i drupalSiteIntent) requiredOutputs() []string {
	required := []string{"composer.json", "composer.lock", "vendor", i.Webroot}
	if i.CMS {
		required = append(required, "recipes")
	}
	return required
}

func (i drupalSiteIntent) webrootAt(root string) string {
	if filepath.IsAbs(i.Webroot) {
		return i.Webroot
	}
	return filepath.Join(root, i.Webroot)
}

type scaffoldOutput struct {
	path string
	ok   func(fs.FileMode) bool
}

func (i drupalSiteIntent) missingOutputs(root string) ([]string, error) {
	webroot := i.webrootAt(root)
	outputs := []scaffoldOutput{
		{filepath.Join(root, "composer.json"), fs.FileMode.IsRegular},
		{filepath.Join(root, "composer.lock"), fs.FileMode.IsRegular},
		{filepath.Join(root, "vendor", "bin", "drush"), func(mode fs.FileMode) bool { return mode.IsRegular() && mode&0o111 != 0 }},
		{filepath.Join(webroot, "index.php"), fs.FileMode.IsRegular},
		{filepath.Join(webroot, "core"), fs.FileMode.IsDir},
	}
	if i.CMS {
		outputs = append(outputs, scaffoldOutput{filepath.Join(root, "recipes", "drupal_cms_starter", "recipe.yml"), fs.FileMode.IsRegular})
	}
	var missing []string
	for _, output := range outputs {
		ok, err := scaffoldOutputExists(output.path, output.ok)
		if err != nil {
			return nil, err
		}
		if !ok {
			missing = append(missing, strings.TrimPrefix(output.path, root+string(filepath.Separator)))
		}
	}
	return missing, nil
}

func scaffoldOutputExists(path string, ok func(fs.FileMode) bool) (bool, error) {
	info, err := os.Stat(path)
	if errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.ENOTDIR) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return ok(info.Mode()), nil
}

func (i drupalSiteIntent) options(s *scaffold, generate func(string, *scaffoldManifest) error) scaffoldOptions {
	required := i.requiredOutputs()
	return scaffoldOptions{
		siteIntent:      &i,
		requiredOutputs: required,
		generate:        generate,
		receipt: func() ([]byte, error) {
			missing, err := i.missingOutputs(s.appRoot)
			if err != nil {
				return nil, err
			}
			if len(missing) != 0 {
				return nil, fmt.Errorf("%s scaffold did not produce %s", s.label, strings.Join(missing, ", "))
			}
			data, err := json.Marshal(drupalSiteReceipt{Version: drupalReceiptVersion, Intent: &i})
			return append(data, '\n'), err
		},
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
				if info.IsDir() && name != "composer.json" && name != "composer.lock" {
					children, err := os.ReadDir(path)
					if err != nil {
						return err
					}
					if len(children) == 0 {
						continue
					}
				}
				return fmt.Errorf("%s already exists; scaffold only generates new projects and did not change this checkout", path)
			}
			_, err := fmt.Fprintf(s.streams.stdout, "Scaffolding %s %s into %s/ (first start downloads dependencies; later starts skip this)…\n", s.label, i.Major, i.Webroot)
			return err
		},
	}
}
