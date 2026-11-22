package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

const (
	scaffoldManifestVersion = 1
	scaffoldLockName        = ".lando-scaffold-lock"
	scaffoldStageRoot       = ".lando-scaffold"
	scaffoldNestedPartial   = ".lando-partial"
	scaffoldNestedOwner     = ".lando-owned"
)

// scaffoldManifest is the durable write-ahead record shared by every scaffold
// command. It is published atomically before the filesystem step it describes,
// so a run killed at any point can resume the same staged generation without
// replaying a step that already happened.
type scaffoldManifest struct {
	Version int             `json:"version"`
	Command string          `json:"command"`
	Phase   string          `json:"phase"`
	Stage   string          `json:"stage"`
	Hooks   map[string]bool `json:"hooks,omitempty"`
	Entries []scaffoldEntry `json:"entries"`
	// Applied is command-owned state recorded while staging and written as the
	// completion marker's contents, so a later run knows what this one applied.
	Applied json.RawMessage `json:"applied,omitempty"`

	SiteIntent *drupalSiteIntent `json:"siteIntent,omitempty"`
}

// scaffoldEntry records one top-level staged path and the exact filesystem
// state promotion left behind.
type scaffoldEntry struct {
	Name     string          `json:"name"`
	State    string          `json:"state"`
	Identity *fileIdentity   `json:"identity,omitempty"`
	Token    string          `json:"token,omitempty"`
	Children []scaffoldChild `json:"children,omitempty"`
}

// scaffoldChild records one entry of an empty-directory target that has to be
// filled in place, because a mount point cannot be replaced by a rename.
type scaffoldChild struct {
	Name     string        `json:"name"`
	State    string        `json:"state"`
	Identity *fileIdentity `json:"identity,omitempty"`
}

// fileIdentity proves a path is the one this run staged or renamed. rename(2)
// preserves the inode, so a recovery can tell its own promoted path from a
// path another writer created after the manifest snapshot.
type fileIdentity struct {
	Dev uint64 `json:"dev"`
	Ino uint64 `json:"ino"`
}

type scaffold struct {
	command         string
	label           string
	markerPrefix    string
	completeMessage string
	outputs         string
	appRoot         string
	stageDir        string
	manifestPath    string
	markerPath      string
	streams         helperIO
	crash           func(string)
	lock            *scaffoldLock
}

type scaffoldOptions struct {
	siteIntent      *drupalSiteIntent
	requiredOutputs []string

	preflight    func(resumed bool, manifest *scaffoldManifest) error
	generate     func(stage string, manifest *scaffoldManifest) error
	afterPromote func(manifest *scaffoldManifest) error
	complete     func(appRoot string) bool
	receipt      func() ([]byte, error)
}

type scaffoldAlreadyComplete struct {
	message string
}

func (e *scaffoldAlreadyComplete) Error() string { return e.message }

func newScaffold(
	command string,
	label string,
	markerPrefix string,
	completeMessage string,
	outputs string,
	appRoot string,
	streams helperIO,
	crash func(string),
) *scaffold {
	s := &scaffold{
		command:         command,
		label:           label,
		markerPrefix:    markerPrefix,
		completeMessage: completeMessage,
		outputs:         outputs,
		appRoot:         appRoot,
		stageDir:        filepath.Join(appRoot, scaffoldStageRoot, command),
		manifestPath:    filepath.Join(appRoot, ".lando-"+markerPrefix+"-manifest"),
		streams:         streams,
		crash:           crash,
	}
	if markerPrefix != "" && completeMessage != "" {
		s.markerPath = scaffoldMarkerPath(appRoot, markerPrefix)
	}
	return s
}

func scaffoldMarkerPath(appRoot, markerPrefix string) string {
	return filepath.Join(appRoot, ".lando-"+markerPrefix+"-complete")
}

// point is the test seam that proves a kill after any single step resumes.
func (s *scaffold) point(name string) {
	if s.crash != nil {
		s.crash(name)
	}
}

func (s *scaffold) execute(options scaffoldOptions) error {
	if err := os.MkdirAll(s.appRoot, 0o755); err != nil {
		return err
	}
	if err := s.acquireLock(); err != nil {
		return err
	}
	defer s.releaseLock()
	return s.executeLocked(options)
}

func (s *scaffold) acquireLock() error {
	lock, err := acquireScaffoldLock(s.appRoot)
	if err != nil {
		return err
	}
	s.lock = lock
	return nil
}

func (s *scaffold) releaseLock() {
	s.lock.release()
	s.lock = nil
}

func (s *scaffold) executeLocked(options scaffoldOptions) error {
	manifest, resumed, err := s.loadManifest()
	if err != nil {
		return err
	}
	hasMarker := s.markerPath != "" && pathExists(s.markerPath)
	if hasMarker && options.complete(s.appRoot) {
		s.cleanup()
		return &scaffoldAlreadyComplete{message: s.completeMessage}
	}
	if resumed && hasMarker {
		// A completion marker whose outputs are gone is repair work, not a
		// completed scaffold: remove it and rebuild from the same manifest.
		if err := os.Remove(s.markerPath); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
	}
	return s.executeManifestLocked(options, manifest)
}

func (s *scaffold) executeManifestLocked(options scaffoldOptions, manifest *scaffoldManifest) error {
	if options.preflight != nil {
		if err := options.preflight(manifest != nil, manifest); err != nil {
			return err
		}
	}
	if manifest == nil {
		manifest = s.newManifest()
		manifest.SiteIntent = options.siteIntent
		if err := s.saveManifest(manifest); err != nil {
			return err
		}
		if err := s.stage(manifest, options); err != nil {
			return err
		}
	} else {
		switch manifest.Phase {
		case "staging":
			if err := s.stage(manifest, options); err != nil {
				return err
			}
		case "staged", "promoted":
			if s.stageRequired(manifest) && !pathExists(s.stageDir) {
				return fmt.Errorf(
					"%s scaffold cannot resume because its staged project is missing from %s.",
					s.label,
					s.stageDir,
				)
			}
		default:
			return fmt.Errorf("Invalid %s scaffold manifest phase: %s", s.label, manifest.Phase)
		}
	}
	if err := s.promote(manifest); err != nil {
		return err
	}
	s.reportKeptPaths(manifest)
	if manifest.Phase != "promoted" {
		manifest.Phase = "promoted"
		if err := s.saveManifest(manifest); err != nil {
			return err
		}
		s.point("promoted")
	}
	if options.afterPromote != nil {
		if err := options.afterPromote(manifest); err != nil {
			return err
		}
	}
	if options.receipt != nil {
		applied, err := options.receipt()
		if err != nil {
			return err
		}
		return s.finish(applied)
	} else if !options.complete(s.appRoot) {
		return fmt.Errorf("%s scaffold did not produce %s.", s.label, s.outputs)
	}
	return s.finish(manifest.Applied)
}
