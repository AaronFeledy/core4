package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

func (s *scaffold) newManifest() *scaffoldManifest {
	stage, err := filepath.Rel(s.appRoot, s.stageDir)
	if err != nil {
		stage = s.stageDir
	}
	return &scaffoldManifest{
		Version: scaffoldManifestVersion,
		Command: s.command,
		Phase:   "staging",
		Stage:   filepath.ToSlash(stage),
		Hooks:   map[string]bool{},
	}
}

func (s *scaffold) stage(manifest *scaffoldManifest, generate func(stage string, manifest *scaffoldManifest) error) error {
	if err := os.RemoveAll(s.stageDir); err != nil {
		return err
	}
	manifest.Phase = "staging"
	manifest.Entries = nil
	manifest.Hooks = map[string]bool{}
	manifest.Contrib = nil
	manifest.ContribInherited = nil
	if err := s.saveManifest(manifest); err != nil {
		return err
	}
	if err := os.MkdirAll(s.stageDir, 0o755); err != nil {
		return err
	}
	s.point("stage-created")
	if err := generate(s.stageDir, manifest); err != nil {
		// A generation failure has promoted nothing. A kill does not run
		// cleanup: the staging phase is replayed from scratch on resume.
		s.cleanup()
		return err
	}
	s.point("generated")
	if err := s.classify(manifest); err != nil {
		s.cleanup()
		return err
	}
	return nil
}

func (s *scaffold) cleanup() {
	_ = os.RemoveAll(s.stageDir)
	_ = os.Remove(s.manifestPath)
	_ = os.Remove(filepath.Join(s.appRoot, scaffoldStageRoot))
	syncDir(s.appRoot)
}

func (s *scaffold) finish() error {
	if err := os.RemoveAll(s.stageDir); err != nil {
		return err
	}
	s.point("stage-removed")
	_ = os.Remove(filepath.Join(s.appRoot, scaffoldStageRoot))
	if s.markerPath != "" {
		file, err := os.OpenFile(s.markerPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
		if err != nil {
			return err
		}
		if len(s.markerData) != 0 {
			if _, err := file.Write(s.markerData); err != nil {
				return errors.Join(err, file.Close())
			}
		}
		if err := file.Sync(); err != nil {
			_ = file.Close()
			return err
		}
		if err := file.Close(); err != nil {
			return err
		}
		syncDir(s.appRoot)
		s.point("complete-marker")
	}
	if err := os.Remove(s.manifestPath); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	syncDir(s.appRoot)
	s.point("manifest-removed")
	return nil
}

func (s *scaffold) saveManifest(manifest *scaffoldManifest) error {
	data, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	temporary := fmt.Sprintf("%s.tmp.%d", s.manifestPath, os.Getpid())
	file, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		_ = os.Remove(temporary)
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		_ = os.Remove(temporary)
		return err
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	if err := os.Rename(temporary, s.manifestPath); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	syncDir(s.appRoot)
	s.point("manifest")
	return nil
}

func (s *scaffold) loadManifest() (*scaffoldManifest, bool, error) {
	data, err := os.ReadFile(s.manifestPath)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	var manifest scaffoldManifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return nil, false, fmt.Errorf("%s scaffold recovery manifest is invalid: %w", s.label, err)
	}
	stage, err := filepath.Rel(s.appRoot, s.stageDir)
	if err != nil {
		stage = s.stageDir
	}
	if manifest.Version != scaffoldManifestVersion ||
		manifest.Command != s.command ||
		manifest.Stage != filepath.ToSlash(stage) {
		return nil, false, fmt.Errorf(
			"%s scaffold recovery manifest does not belong to this app root.",
			s.label,
		)
	}
	for _, entry := range manifest.Entries {
		if err := s.validateStagedName(entry.Name); err != nil {
			return nil, false, err
		}
		switch entry.State {
		case "preexisting", "pending", "ready", "complete", "nested-pending", "nested-incomplete", "nested-ready":
		default:
			return nil, false, fmt.Errorf("Invalid %s scaffold manifest state: %s", s.label, entry.State)
		}
	}
	if manifest.Hooks == nil {
		manifest.Hooks = map[string]bool{}
	}
	return &manifest, true, nil
}

func (s *scaffold) stageRequired(manifest *scaffoldManifest) bool {
	for _, entry := range manifest.Entries {
		switch entry.State {
		case "pending", "ready", "nested-pending":
			return true
		}
	}
	return false
}

func (s *scaffold) validateStagedName(name string) error {
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, "/\x00\n") {
		return fmt.Errorf("Invalid %s scaffold entry: %s", s.label, name)
	}
	if name == scaffoldStageRoot || name == scaffoldLockName || name == contribSyncRecordName ||
		strings.HasPrefix(name, contribSyncRecordName+".tmp.") || name == filepath.Base(s.manifestPath) ||
		(s.markerPath != "" && name == filepath.Base(s.markerPath)) {
		return fmt.Errorf("Invalid %s scaffold entry: %s is reserved for Lando.", s.label, name)
	}
	return nil
}
