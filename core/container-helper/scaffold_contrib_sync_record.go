package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

const contribSyncRecordName = ".lando-drupal-contrib-sync.json"

type contribSyncRecord struct {
	Version    int               `json:"version"`
	Require    map[string]string `json:"require"`
	RequireDev map[string]string `json:"requireDev"`
}

func (record contribSyncRecord) bucket(dev bool) map[string]string {
	if dev {
		return record.RequireDev
	}
	return record.Require
}

func loadContribSyncRecord(root string) contribSyncRecord {
	path := filepath.Join(root, contribSyncRecordName)
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		return contribSyncRecord{}
	}
	data, err := os.ReadFile(path)
	var record contribSyncRecord
	if err != nil || json.Unmarshal(data, &record) != nil || record.Version != 1 || record.Require == nil || record.RequireDev == nil {
		return contribSyncRecord{}
	}
	for _, dev := range []bool{false, true} {
		for name := range record.bucket(dev) {
			if !contribPackagePattern.MatchString(name) || name != strings.ToLower(name) {
				return contribSyncRecord{}
			}
		}
	}
	return record
}

func (record contribSyncRecord) save(root string) error {
	file, err := os.CreateTemp(root, contribSyncRecordName+".tmp.")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if err := json.NewEncoder(file).Encode(record); err != nil {
		return errors.Join(err, file.Close())
	}
	if err := file.Sync(); err != nil {
		return errors.Join(err, file.Close())
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := os.Rename(file.Name(), filepath.Join(root, contribSyncRecordName)); err != nil {
		return err
	}
	syncDir(root)
	return nil
}
