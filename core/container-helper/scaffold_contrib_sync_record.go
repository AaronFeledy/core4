package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// contribSyncRecord is the managed requirement set a sync last applied. The
// completion marker holds it, so "complete" always names what was applied.
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

// manages reports whether the record applied name in either bucket.
func (record contribSyncRecord) manages(name string) bool {
	_, prod := record.Require[name]
	_, dev := record.RequireDev[name]
	return prod || dev
}

// loadContribSyncRecord reads a marker's record. A missing or unreadable one
// is an empty record: the next sync reapplies every managed requirement.
func loadContribSyncRecord(marker string) contribSyncRecord {
	info, err := os.Lstat(marker)
	if err != nil || !info.Mode().IsRegular() {
		return contribSyncRecord{}
	}
	data, err := os.ReadFile(marker)
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

// save replaces the marker atomically, so a crash keeps either record.
func (record contribSyncRecord) save(marker string) error {
	dir := filepath.Dir(marker)
	file, err := os.CreateTemp(dir, filepath.Base(marker)+".tmp.")
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
	if err := os.Rename(file.Name(), marker); err != nil {
		return err
	}
	syncDir(dir)
	return nil
}
