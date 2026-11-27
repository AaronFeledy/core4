package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

func (i drupalSiteIntent) prepareComposer(stage string) (string, error) {
	path := filepath.Join(stage, "composer.json")
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	var manifest struct {
		Require map[string]string `json:"require"`
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		return "", err
	}
	constraint := manifest.Require["drupal/core-recommended"]
	if constraint == "" {
		return "", errors.New("the Drupal template does not constrain drupal/core-recommended")
	}
	if i.Webroot == "web" {
		return constraint, nil
	}

	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return "", err
	}
	var extra map[string]json.RawMessage
	if err := json.Unmarshal(fields["extra"], &extra); err != nil {
		return "", err
	}
	var scaffold map[string]json.RawMessage
	if err := json.Unmarshal(extra["drupal-scaffold"], &scaffold); err != nil {
		return "", err
	}
	var locations map[string]string
	if err := json.Unmarshal(scaffold["locations"], &locations); err != nil {
		return "", err
	}
	if locations["web-root"] != "web/" {
		return "", errors.New("the Drupal template no longer uses web/ as its scaffold root")
	}
	locations["web-root"] = i.Webroot + "/"
	if scaffold["locations"], err = json.Marshal(locations); err != nil {
		return "", err
	}
	if extra["drupal-scaffold"], err = json.Marshal(scaffold); err != nil {
		return "", err
	}
	if extra["installer-paths"], err = relocateDrupalInstallerPaths(extra["installer-paths"], i.Webroot); err != nil {
		return "", err
	}
	if fields["extra"], err = json.Marshal(extra); err != nil {
		return "", err
	}
	output, err := json.MarshalIndent(fields, "", "    ")
	if err != nil {
		return "", err
	}
	stagedRoot := filepath.Join(stage, "web")
	info, err := os.Lstat(stagedRoot)
	switch {
	case errors.Is(err, fs.ErrNotExist):
	case err != nil:
		return "", err
	case !info.IsDir():
		return "", errors.New("the Drupal template's staged web path is not a directory")
	default:
		if err := renameNoReplace(stagedRoot, filepath.Join(stage, i.Webroot)); err != nil {
			return "", fmt.Errorf("could not move the Drupal template's staged web directory: %w", err)
		}
	}
	return constraint, os.WriteFile(path, append(output, '\n'), 0o644)
}

func relocateDrupalInstallerPaths(data json.RawMessage, webroot string) (json.RawMessage, error) {
	keys, values, err := orderedObjectKeys(data)
	if err != nil {
		return nil, err
	}
	if _, found := values["web/core"]; !found {
		return nil, errors.New("the Drupal template does not install core under web/")
	}
	var output bytes.Buffer
	output.WriteByte('{')
	seen := make(map[string]bool, len(keys))
	for index, key := range keys {
		target := key
		if tail, found := strings.CutPrefix(key, "web/"); found {
			target = webroot + "/" + tail
		}
		if seen[target] {
			return nil, fmt.Errorf("duplicate Drupal installer path %q", target)
		}
		seen[target] = true
		if index > 0 {
			output.WriteByte(',')
		}
		name, _ := json.Marshal(target) // Encoding a string cannot fail.
		output.Write(name)
		output.WriteByte(':')
		output.Write(values[key])
	}
	output.WriteByte('}')
	return output.Bytes(), nil
}
