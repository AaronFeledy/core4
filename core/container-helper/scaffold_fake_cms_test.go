package main

import (
	"encoding/json"
	"maps"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

func fakeCmsComposer(command string, workingDir string, positional []string, dev bool, env map[string]string) int {
	mode := env["LANDO_TEST_COMPOSER_MODE"]
	switch command {
	case "create-project":
		if len(positional) < 2 {
			return 2
		}
		target := positional[1]
		_ = os.MkdirAll(filepath.Join(target, "web", "core", "lib"), 0o755)
		root := map[string]any{
			"config":       map[string]any{"allow-plugins": map[string]any{"composer/installers": true}},
			"require":      map[string]any{"drupal/core-recommended": "^11.4"},
			"extra":        json.RawMessage(`{"drupal-scaffold":{"locations":{"web-root":"web/"}},"installer-paths":{"web/core":["type:drupal-core"]}}`),
			"repositories": map[string]any{"drupal": map[string]any{"type": "composer", "url": "https://packages.drupal.org/8"}},
			"scripts": map[string][]string{
				"post-update-cmd": {`@php -r "@unlink('vendor/bin/composer');"`},
				"post-install-cmd": {"@post-update-cmd"},
			},
		}
		writeFakeJSON(filepath.Join(target, "composer.json"), root)
		_ = os.WriteFile(filepath.Join(target, "web", "early.txt"), []byte("early\n"), 0o644)
		_ = os.WriteFile(filepath.Join(target, "web", "index.php"), []byte("<?php\n"), 0o644)
		_ = os.WriteFile(filepath.Join(target, ".gitignore"), []byte("/web/core\n/web/sites/*/settings*.php\n"), 0o644)
		_ = os.WriteFile(filepath.Join(target, "web", "core", "lib", "Drupal.php"), []byte("late\n"), 0o644)
		return 0
	case "config":
		if len(positional) != 2 {
			return 2
		}
		root := readFakeJSON(filepath.Join(workingDir, "composer.json"))
		if plugin, ok := strings.CutPrefix(positional[0], "allow-plugins."); ok {
			allowed, err := strconv.ParseBool(positional[1])
			if err != nil {
				return 2
			}
			root["config"].(map[string]any)["allow-plugins"].(map[string]any)[plugin] = allowed
			writeCmsComposer(filepath.Join(workingDir, "composer.json"), root)
			return 0
		}
		repository := readFakeJSONBytes([]byte(positional[1]))
		if mode == "repo-tamper" {
			repository["package"].(map[string]any)["description"] = "tampered"
		}
		repositories := root["repositories"].(map[string]any)
		repositories["lando-svg-image"] = repository
		writeCmsComposer(filepath.Join(workingDir, "composer.json"), root)
		return 0
	case "require":
		root := readFakeJSON(filepath.Join(workingDir, "composer.json"))
		if dev {
			requireDev := make(map[string]string, len(positional))
			for _, requirement := range positional {
				name, constraint, ok := strings.Cut(requirement, ":")
				if !ok {
					return 2
				}
				requireDev[name] = constraint
			}
			root["require-dev"] = requireDev
			writeCmsComposer(filepath.Join(workingDir, "composer.json"), root)
			return 0
		}
		require := root["require"].(map[string]any)
		for _, requirement := range positional {
			name, constraint, ok := strings.Cut(requirement, ":")
			if !ok {
				return 2
			}
			require[name] = constraint
		}
		writeCmsComposer(filepath.Join(workingDir, "composer.json"), root)
		return 0
	case "update":
		if mode == "resolve-fail" {
			return 6
		}
		root := readFakeJSON(filepath.Join(workingDir, "composer.json"))
		repository := root["repositories"].(map[string]any)["lando-svg-image"].(map[string]any)
		pkg := maps.Clone(repository["package"].(map[string]any))
		delete(pkg, "minimum-stability")
		pkg["license"] = fakeLicense(pkg["license"])
		aliases := []any{}
		switch mode {
		case "lock-ref":
			pkg["source"].(map[string]any)["reference"] = strings.Repeat("a", 40)
		case "lock-url":
			pkg["source"].(map[string]any)["url"] = "https://example.test/evil.git"
		case "lock-type":
			pkg["type"] = "composer-plugin"
		case "lock-license":
			pkg["license"] = []any{"MIT"}
		case "lock-version":
			pkg["version"] = "3.2.4"
		case "lock-alias":
			aliases = append(aliases, map[string]any{"package": "drupal/svg_image", "version": "3.x-dev", "alias": "3.2.4"})
		case "lock-require":
			pkg["require"].(map[string]any)["enshrined/svg-sanitize"] = "^0.22"
		case "lock-autoload":
			pkg["autoload"] = map[string]any{"files": []any{"evil.php"}}
		case "lock-extra":
			pkg["extra"] = map[string]any{"installer-name": "evil"}
		}
		lock := map[string]any{
			"packages": []any{pkg, map[string]any{"name": "enshrined/svg-sanitize", "version": "1.0.0"}},
			"aliases":  aliases,
		}
		writeFakeJSON(filepath.Join(workingDir, "composer.lock"), lock)
		return 0
	case "audit":
		if mode == "audit-fail" {
			return 7
		}
		return 0
	case "install":
		if mode == "install-fail" {
			return 8
		}
		root := readFakeJSON(filepath.Join(workingDir, "composer.json"))
		lock := readFakeJSON(filepath.Join(workingDir, "composer.lock"))
		pkg := lock["packages"].([]any)[0].(map[string]any)
		source := maps.Clone(pkg["source"].(map[string]any))
		_ = os.MkdirAll(filepath.Join(workingDir, "vendor", "bin"), 0o755)
		_ = os.MkdirAll(filepath.Join(workingDir, "vendor", "composer"), 0o755)
		binaries := []string{"drush", "composer"}
		requireDev, _ := root["require-dev"].(map[string]any)
		if _, ok := requireDev["drupal/coder"]; ok {
			binaries = append(binaries, "phpcs", "phpcbf")
		}
		if _, ok := requireDev["phpstan/phpstan"]; ok {
			binaries = append(binaries, "phpstan")
		}
		if code := fakeComposerBinaries(workingDir, mode, binaries...); code != 0 {
			return code
		}
		scripts := root["scripts"].(map[string]any)
		if alias := scripts["post-install-cmd"].([]any)[0]; alias == "@post-update-cmd" && fakeCmsComposer("run-script", workingDir, []string{"post-update-cmd"}, dev, env) != 0 {
			return 2
		}
		if mode == "installed-source" {
			source["reference"] = strings.Repeat("b", 40)
		}
		installed := map[string]any{"packages": []any{map[string]any{
			"name":                "drupal/svg_image",
			"source":              source,
			"installation-source": "source",
		}}}
		writeFakeJSON(filepath.Join(workingDir, "vendor", "composer", "installed.json"), installed)
		metadata := maps.Clone(root["repositories"].(map[string]any)["lando-svg-image"].(map[string]any)["package"].(map[string]any))
		delete(metadata, "version")
		delete(metadata, "source")
		if mode == "installed-require" {
			metadata["require"].(map[string]any)["enshrined/svg-sanitize"] = "^0.22"
		}
		if mode == "installed-extra" {
			metadata["extra"] = map[string]any{"installer-name": "evil"}
		}
		webroot := root["extra"].(map[string]any)["drupal-scaffold"].(map[string]any)["locations"].(map[string]any)["web-root"].(string)
		svg := filepath.Join(workingDir, webroot, "modules", "contrib", "svg_image")
		if err := os.MkdirAll(svg, 0o755); err != nil {
			return 2
		}
		writeFakeJSON(filepath.Join(svg, "composer.json"), metadata)
		if _, ok := root["require"].(map[string]any)["drupal/drupal_cms_starter"]; ok {
			_ = os.MkdirAll(filepath.Join(workingDir, "recipes", "drupal_cms_starter"), 0o755)
			_ = os.WriteFile(filepath.Join(workingDir, "recipes", "drupal_cms_starter", "recipe.yml"), []byte("name: Starter\n"), 0o644)
		}
		return 0
	case "run-script":
		root := readFakeJSON(filepath.Join(workingDir, "composer.json"))
		if len(positional) == 0 {
			return 2
		}
		switch positional[0] {
		case "post-update-cmd":
			if err := os.Remove(filepath.Join(workingDir, "vendor", "bin", "composer")); err != nil {
				return 2
			}
			return 0
		case "post-create-project-cmd":
			require := root["require"].(map[string]any)
			delete(require, "drupal/drupal_cms_starter")
			if _, exists := require["drupal/svg_image"]; !exists || mode == "hook-rewrite" {
				require["drupal/svg_image"] = "^3.1"
			}
			require["drupal/gin"] = "^5"
			writeCmsComposer(filepath.Join(workingDir, "composer.json"), root)
			return 0
		}
		return 2
	}
	return 2
}

// writeCmsComposer preserves the reviewed repository first, the way
// `composer config repositories.lando-svg-image --json` prepends its key.
func writeCmsComposer(path string, root map[string]any) {
	repositories := root["repositories"].(map[string]any)
	order := make([]string, 0, len(repositories))
	if _, ok := repositories["lando-svg-image"]; ok {
		order = append(order, "lando-svg-image")
	}
	rest := make([]string, 0, len(repositories))
	for name := range repositories {
		if name != "lando-svg-image" {
			rest = append(rest, name)
		}
	}
	sort.Strings(rest)
	order = append(order, rest...)
	keys := make([]string, 0, len(root))
	for key := range root {
		if key != "repositories" {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	var builder strings.Builder
	builder.WriteString("{")
	for index, key := range keys {
		if index > 0 {
			builder.WriteString(",")
		}
		keyJSON, _ := json.Marshal(key)
		valueJSON, _ := json.Marshal(root[key])
		builder.Write(keyJSON)
		builder.WriteString(":")
		builder.Write(valueJSON)
	}
	if len(keys) > 0 {
		builder.WriteString(",")
	}
	builder.WriteString(`"repositories":{`)
	for index, name := range order {
		if index > 0 {
			builder.WriteString(",")
		}
		nameJSON, _ := json.Marshal(name)
		valueJSON, _ := json.Marshal(repositories[name])
		builder.Write(nameJSON)
		builder.WriteString(":")
		builder.Write(valueJSON)
	}
	builder.WriteString("}}")
	_ = os.WriteFile(path, []byte(builder.String()), 0o644)
}
