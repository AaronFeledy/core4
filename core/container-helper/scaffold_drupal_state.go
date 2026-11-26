package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
	"strings"
)

const drupalReceiptVersion = 1

type drupalSiteReceipt struct {
	Version int               `json:"version"`
	Intent  *drupalSiteIntent `json:"intent"`
}

func (i *drupalSiteIntent) UnmarshalJSON(data []byte) error {
	type intent drupalSiteIntent
	var record struct {
		intent
		Testing *bool `json:"testing"`
	}
	if err := json.Unmarshal(data, &record); err != nil {
		return err
	}
	if record.Testing == nil {
		return errors.New("missing scaffold testing choice")
	}
	*i = drupalSiteIntent(record.intent)
	i.Testing = *record.Testing
	return i.validateGenerationRoot()
}

func (s *scaffold) readDrupalReceipt() (*drupalSiteReceipt, error) {
	data, err := readScaffoldRecord(s.markerPath)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	// Scaffolds before receipts left an empty marker: a finished site whose choices were never recorded.
	if len(strings.TrimSpace(string(data))) == 0 {
		return nil, nil
	}
	var receipt drupalSiteReceipt
	if err := json.Unmarshal(data, &receipt); err != nil {
		return nil, fmt.Errorf("invalid %s scaffold receipt: %w", s.label, err)
	}
	if receipt.Version != drupalReceiptVersion || !s.validDrupalIntent(receipt.Intent) {
		return nil, fmt.Errorf("invalid %s scaffold receipt at %s", s.label, s.markerPath)
	}
	return &receipt, nil
}

func (s *scaffold) validDrupalIntent(intent *drupalSiteIntent) bool {
	return intent != nil && ((s.command == "drupal-cms-scaffold" && intent.CMS && intent.Major == drupalCmsMajor) ||
		(s.command == "drupal-scaffold" && !intent.CMS && drupalMajorPattern.MatchString(intent.Major)))
}

func (s *scaffold) executeDrupalSite(intent drupalSiteIntent, generate func(string, *scaffoldManifest) error) error {
	manifest, receipt, err := s.drupalRecords()
	if err != nil {
		return err
	}
	if manifest == nil {
		if receipt != nil {
			return s.checkDrupalReceipt(intent, *receipt.Intent)
		}
		adopted, err := s.existingDrupalSite(intent)
		if err != nil {
			return err
		}
		if adopted {
			// A concurrent helper may have promoted composer.json since we read
			// the records. Do not adopt an unfinished scaffold as a checkout.
			manifest, receipt, err = s.drupalRecords()
			if err != nil {
				return err
			}
			if manifest == nil {
				if receipt != nil {
					return s.checkDrupalReceipt(intent, *receipt.Intent)
				}
				return s.reportDrupalAdoption()
			}
		}
	}
	if manifest == nil {
		if err := intent.validateGenerationRoot(); err != nil {
			return err
		}
	}
	if err := s.acquireLock(); err != nil {
		return err
	}
	defer s.releaseLock()
	return s.executeDrupalSiteLocked(intent, generate)
}

func (s *scaffold) drupalRecords() (*scaffoldManifest, *drupalSiteReceipt, error) {
	manifest, _, err := s.loadManifest()
	if err != nil {
		return nil, nil, err
	}
	if manifest != nil {
		if !s.validDrupalIntent(manifest.SiteIntent) {
			return nil, nil, fmt.Errorf("invalid %s scaffold journal: missing or invalid recorded intent", s.label)
		}
		if (manifest.Phase == "staging") != (len(manifest.Entries) == 0) {
			return nil, nil, fmt.Errorf("invalid %s scaffold journal: entries do not match phase %q", s.label, manifest.Phase)
		}
	}
	receipt, err := s.readDrupalReceipt()
	return manifest, receipt, err
}

func (s *scaffold) executeDrupalSiteLocked(intent drupalSiteIntent, generate func(string, *scaffoldManifest) error) error {
	manifest, receipt, err := s.drupalRecords()
	if err != nil {
		return err
	}
	if receipt != nil && manifest != nil && (manifest.Phase != "promoted" || *manifest.SiteIntent != *receipt.Intent) {
		return fmt.Errorf("%s scaffold journal and receipt disagree", s.label)
	}
	if manifest != nil && *manifest.SiteIntent != intent {
		if manifest.promotionStarted() {
			original := manifest.SiteIntent
			return fmt.Errorf("%s scaffold already in progress: resume with webroot %q, Drupal major %q and testing=%t, then run lando start", s.label, original.Webroot, original.Major, original.Testing)
		}
		if err := intent.validateGenerationRoot(); err != nil {
			return err
		}
		return s.executeManifestLocked(intent.options(s, generate), nil)
	}
	if receipt != nil {
		if err := s.checkDrupalReceipt(intent, *receipt.Intent); err != nil {
			return err
		}
		if manifest != nil {
			return s.retireManifest()
		}
		return nil
	}
	if manifest == nil {
		adopted, err := s.existingDrupalSite(intent)
		if err != nil {
			return err
		}
		if adopted {
			return s.reportDrupalAdoption()
		}
		if err := intent.validateGenerationRoot(); err != nil {
			return err
		}
	}
	return s.executeManifestLocked(intent.options(s, generate), manifest)
}

func (m *scaffoldManifest) promotionStarted() bool {
	if m.Phase == "promoted" {
		return true
	}
	for _, entry := range m.Entries {
		switch entry.State {
		case "pending", "nested-pending", "preexisting":
		default:
			return true
		}
	}
	return false
}

func (s *scaffold) checkDrupalReceipt(intent, recorded drupalSiteIntent) error {
	missing, err := intent.missingOutputs(s.appRoot)
	if err != nil {
		return err
	}
	if len(missing) != 0 && intent.Webroot != recorded.Webroot {
		return fmt.Errorf("%s was scaffolded into %q, but the configured webroot %q is missing required outputs: %s. Restore recipe.options.webroot in .lando.yml or finish moving the site and update its Composer paths", s.label, recorded.Webroot, intent.Webroot, strings.Join(missing, ", "))
	}
	if len(missing) != 0 {
		return fmt.Errorf("%s scaffold is missing required outputs: %s. Restore project files from your checkout or backup, and run lando composer install to restore dependencies", s.label, strings.Join(missing, ", "))
	}
	if intent.Major != recorded.Major || intent.Testing != recorded.Testing {
		_, err := fmt.Fprintln(s.streams.stdout, "Lando does not change an existing site's Drupal version or test dependencies. Update composer.json and run lando composer update to change them.")
		return err
	}
	_, err = fmt.Fprintln(s.streams.stdout, s.completeMessage)
	return err
}

func (s *scaffold) existingDrupalSite(intent drupalSiteIntent) (bool, error) {
	composer, err := scaffoldOutputExists(filepath.Join(s.appRoot, "composer.json"), fs.FileMode.IsRegular)
	if err != nil || composer {
		return composer, err
	}
	webroot := intent.webrootAt(s.appRoot)
	index, err := scaffoldOutputExists(filepath.Join(webroot, "index.php"), fs.FileMode.IsRegular)
	if err != nil || !index {
		return false, err
	}
	return scaffoldOutputExists(filepath.Join(webroot, "core", "lib", "Drupal.php"), fs.FileMode.IsRegular)
}

func (s *scaffold) reportDrupalAdoption() error {
	_, err := fmt.Fprintf(s.streams.stdout, "%s scaffold skipped: using the existing project.\n", s.label)
	return err
}
