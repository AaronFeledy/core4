package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
)

const cmsSvgCommit = "c788b1e2f2be29f62c9812b2b0558472afa61d6d"

// cmsSvgRepositoryJSON is the reviewed root-package projection of the
// drupal/svg_image merge-request patch. The same bytes configure Composer and
// prove the resulting lock, checkout, and installed record.
func cmsSvgRepositoryJSON() string {
	repository := map[string]any{
		"type": "package",
		"package": map[string]any{
			"name":              "drupal/svg_image",
			"description":       "Overrides the standard image formatter and widget to support SVG files.",
			"type":              "drupal-module",
			"license":           "GPL-2.0-or-later",
			"minimum-stability": "dev",
			"homepage":          "https://drupal.org/project/svg_image",
			"authors": []any{
				map[string]any{
					"name":     "Yaroslav Lushnikov",
					"homepage": "https://www.drupal.org/u/imyaro",
					"role":     "Maintainer",
				},
				map[string]any{
					"name":     "See contributors",
					"homepage": "https://www.drupal.org/node/2887125/committers",
				},
			},
			"support": map[string]any{
				"issues": "https://www.drupal.org/project/issues/svg_image",
				"source": "https://git.drupalcode.org/project/svg_image",
			},
			"require": map[string]any{"enshrined/svg-sanitize": "^1.0"},
			"version": "3.x-dev",
			"source": map[string]any{
				"type":      "git",
				"url":       "https://git.drupalcode.org/issue/svg_image-3629505.git",
				"reference": cmsSvgCommit,
			},
		},
	}
	data, err := json.Marshal(repository)
	if err != nil {
		panic(err)
	}
	return string(data)
}

var cmsForbiddenLockKeys = []string{
	"autoload",
	"autoload-dev",
	"extra",
	"bin",
	"scripts",
	"include-path",
	"target-dir",
	"replace",
	"provide",
	"conflict",
	"dist",
}

// verifyCmsProjection is the Go port of the pinned drupal/svg_image verifier
// that guarded the staged Composer project. "locked" checks the negotiation
// before installation; "installed" additionally proves the checkout and the
// installed record match the reviewed projection.
func verifyCmsProjection(root string, phase string, repositoryJSON string) error {
	expected, err := decodeJSONObject([]byte(repositoryJSON))
	if err != nil {
		return fmt.Errorf("invalid reviewed repository projection: %w", err)
	}
	packageMetadata, ok := expected["package"].(map[string]any)
	if !ok {
		return errors.New("invalid reviewed repository projection")
	}
	upstream := cloneObject(packageMetadata)
	delete(upstream, "version")
	delete(upstream, "source")
	reviewed := cloneObject(upstream)
	delete(reviewed, "minimum-stability")
	reviewed["license"] = licenseArray(reviewed["license"])

	rootData, err := os.ReadFile(filepath.Join(root, "composer.json"))
	if err != nil {
		return err
	}
	rootJSON, err := decodeJSONObject(rootData)
	if err != nil {
		return err
	}
	require, _ := rootJSON["require"].(map[string]any)
	if require["drupal/svg_image"] != "3.x-dev" || require["enshrined/svg-sanitize"] != "^1.0" {
		return rejectCmsProjection("root requirement changed")
	}
	repository, err := firstRepository(rootData)
	if err != nil {
		return err
	}
	if !reflect.DeepEqual(repository, expected) {
		return rejectCmsProjection("repository projection changed")
	}

	lock, err := readJSONObject(filepath.Join(root, "composer.lock"))
	if err != nil {
		return err
	}
	entry, err := singleLockedPackage(lock)
	if err != nil {
		return err
	}
	entry["license"] = licenseArray(entry["license"])
	source, _ := packageMetadata["source"].(map[string]any)
	if entry["version"] != "3.x-dev" || !reflect.DeepEqual(entry["source"], source) {
		return rejectCmsProjection("lock source changed")
	}
	for _, key := range cmsForbiddenLockKeys {
		if _, exists := entry[key]; exists {
			return rejectCmsProjection("lock source changed")
		}
	}
	for key, value := range reviewed {
		if !reflect.DeepEqual(entry[key], value) {
			return rejectCmsProjection("lock metadata changed: " + key)
		}
	}
	if aliases, ok := lock["aliases"].([]any); ok {
		for _, alias := range aliases {
			if record, ok := alias.(map[string]any); ok && record["package"] == "drupal/svg_image" {
				return rejectCmsProjection("lock alias present")
			}
		}
	}
	if phase == "locked" {
		return nil
	}

	checkout, err := readJSONObject(filepath.Join(root, "web", "modules", "contrib", "svg_image", "composer.json"))
	if err != nil {
		return err
	}
	if !reflect.DeepEqual(checkout, upstream) {
		return rejectCmsProjection("installed metadata changed")
	}
	installed, err := readJSONObject(filepath.Join(root, "vendor", "composer", "installed.json"))
	if err != nil {
		return err
	}
	records, err := packagesNamed(installed["packages"], "drupal/svg_image")
	if err != nil {
		return err
	}
	if len(records) != 1 ||
		!reflect.DeepEqual(records[0]["source"], source) ||
		records[0]["installation-source"] != "source" {
		return rejectCmsProjection("installed source changed")
	}
	return nil
}

func rejectCmsProjection(reason string) error {
	return fmt.Errorf("drupal/svg_image %s", reason)
}
