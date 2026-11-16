package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
)

func singleLockedPackage(lock map[string]any) (map[string]any, error) {
	records := make([]map[string]any, 0, 2)
	for _, field := range []string{"packages", "packages-dev"} {
		packages, err := packagesNamed(lock[field], "drupal/svg_image")
		if err != nil {
			return nil, err
		}
		records = append(records, packages...)
	}
	if len(records) != 1 {
		return nil, rejectCmsProjection("lock entry is missing")
	}
	return records[0], nil
}

func packagesNamed(value any, name string) ([]map[string]any, error) {
	packages, _ := value.([]any)
	matches := make([]map[string]any, 0, len(packages))
	for _, entry := range packages {
		record, ok := entry.(map[string]any)
		if !ok {
			return nil, rejectCmsProjection("lock entry is malformed")
		}
		if record["name"] == name {
			matches = append(matches, record)
		}
	}
	return matches, nil
}

// firstRepository reproduces PHP's array_key_first: the first declared
// repository must be the reviewed projection. Composer 2 writes named
// repositories as a list with a `name` field, while an authored file may use a
// named object; both forms are accepted and the wrapper name is removed before
// the projection comparison.
func firstRepository(composerJSON []byte) (map[string]any, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(composerJSON, &fields); err != nil {
		return nil, err
	}
	raw := bytes.TrimSpace(fields["repositories"])
	if len(raw) == 0 {
		return nil, rejectCmsProjection("repository is not first")
	}
	var repository map[string]any
	switch raw[0] {
	case '[':
		var entries []json.RawMessage
		if err := json.Unmarshal(raw, &entries); err != nil {
			return nil, err
		}
		if len(entries) == 0 {
			return nil, rejectCmsProjection("repository is not first")
		}
		decoded, err := decodeJSONObject(entries[0])
		if err != nil {
			return nil, err
		}
		if name, _ := decoded["name"].(string); name != "lando-svg-image" {
			return nil, rejectCmsProjection("repository is not first")
		}
		repository = decoded
	case '{':
		keys, values, err := orderedObjectKeys(raw)
		if err != nil {
			return nil, err
		}
		if len(keys) == 0 {
			return nil, rejectCmsProjection("repository is not first")
		}
		decoded, err := decodeJSONObject(values[keys[0]])
		if err != nil {
			return nil, err
		}
		if name, ok := decoded["name"].(string); ok {
			if name != "lando-svg-image" {
				return nil, rejectCmsProjection("repository is not first")
			}
		} else if keys[0] != "lando-svg-image" {
			return nil, rejectCmsProjection("repository is not first")
		}
		repository = decoded
	default:
		return nil, rejectCmsProjection("repository is not first")
	}
	delete(repository, "name")
	return repository, nil
}

func readJSONObject(path string) (map[string]any, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return map[string]any{}, nil
		}
		return nil, err
	}
	return decodeJSONObject(data)
}

func decodeJSONObject(data []byte) (map[string]any, error) {
	var value any
	if err := json.Unmarshal(data, &value); err != nil {
		return nil, err
	}
	object, ok := value.(map[string]any)
	if !ok {
		return nil, errors.New("expected a JSON object")
	}
	return object, nil
}

func orderedObjectKeys(data []byte) ([]string, map[string]json.RawMessage, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	token, err := decoder.Token()
	if err != nil {
		return nil, nil, err
	}
	if delimiter, ok := token.(json.Delim); !ok || delimiter != '{' {
		return nil, nil, errors.New("expected a JSON object")
	}
	keys := make([]string, 0)
	values := make(map[string]json.RawMessage)
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return nil, nil, err
		}
		key, ok := keyToken.(string)
		if !ok {
			return nil, nil, errors.New("expected a JSON object key")
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, nil, err
		}
		keys = append(keys, key)
		values[key] = value
	}
	return keys, values, nil
}

func cloneObject(value map[string]any) map[string]any {
	clone := make(map[string]any, len(value))
	for key, entry := range value {
		clone[key] = entry
	}
	return clone
}

func licenseArray(value any) []any {
	if entries, ok := value.([]any); ok {
		return entries
	}
	if value == nil {
		return []any{}
	}
	return []any{value}
}
