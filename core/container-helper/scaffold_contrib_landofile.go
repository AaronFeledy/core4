package main

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

func updateContribLandofile(path, constraint string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("Landofile is not a regular file")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	text := string(data)
	value, ok := findYAMLBlockValue(text, "recipe", "options", "drupal")
	if !ok {
		return errors.New("expected a single-line recipe.options.drupal value inside block mappings")
	}
	encoded, err := json.Marshal(constraint)
	if err != nil {
		return err
	}
	replacement := string(encoded)
	if value.start == value.end {
		// Insert after the colon and leave any existing comment separation intact.
		replacement = " " + replacement
	}
	return replaceContribLandofile(path, text[:value.start]+replacement+text[value.end:], info.Mode())
}

func replaceContribLandofile(path, text string, mode fs.FileMode) error {
	dir := filepath.Dir(path)
	file, err := os.CreateTemp(dir, ".lando.yml.*")
	if err != nil {
		return err
	}
	temp := file.Name()
	defer os.Remove(temp)
	if _, err := file.WriteString(text); err != nil {
		return errors.Join(err, file.Close())
	}
	if err := file.Chmod(mode); err != nil {
		return errors.Join(err, file.Close())
	}
	if err := file.Sync(); err != nil {
		return errors.Join(err, file.Close())
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := os.Rename(temp, path); err != nil {
		return err
	}
	syncDir(dir)
	return nil
}

type yamlValueSpan struct{ start, end int }

func yamlRootString(text, key string) string {
	span, ok := findYAMLBlockValue(text, key)
	if !ok {
		return ""
	}
	value := text[span.start:span.end]
	if strings.HasPrefix(value, `"`) {
		var decoded string
		if json.Unmarshal([]byte(value), &decoded) == nil {
			return decoded
		}
	}
	if strings.HasPrefix(value, "'") {
		return strings.ReplaceAll(value[1:len(value)-1], "''", "'")
	}
	return value
}

type yamlBlockLine struct {
	indent int
	offset int
	text   string
}

// Walk only direct mapping children. Offsets refer to the original bytes so
// comments, whitespace, and line endings never need to be reserialized.
func findYAMLBlockValue(text string, path ...string) (yamlValueSpan, bool) {
	var lines []yamlBlockLine
	offset := 0
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimSuffix(raw, "\r")
		if offset == 0 {
			line = strings.TrimPrefix(line, "\ufeff")
		}
		content := strings.TrimLeft(line, " ")
		indent := len(line) - len(content)
		if strings.TrimSpace(content) != "" && !strings.HasPrefix(content, "#") {
			if indent == 0 {
				marker, _, _ := strings.Cut(strings.ReplaceAll(content, "\t", " "), " ")
				if marker == "..." || (len(lines) > 0 && marker == "---") {
					break
				}
				if marker == "---" || strings.HasPrefix(marker, "%") {
					offset += len(raw) + 1
					continue
				}
			}
			lines = append(lines, yamlBlockLine{indent, offset + len(strings.TrimSuffix(raw, "\r")) - len(content), content})
		}
		offset += len(raw) + 1
	}
	indent := 0
	for depth, key := range path {
		var span yamlValueSpan
		var block []yamlBlockLine
		found := false
		for i, line := range lines {
			if line.indent != indent {
				continue
			}
			before, after, ok := strings.Cut(line.text, ":")
			if !ok || (after != "" && after[0] != ' ' && after[0] != '\t') {
				continue
			}
			switch strings.TrimRight(before, " \t") {
			case key, `"` + key + `"`, "'" + key + "'":
			default:
				continue
			}
			value, ok := yamlInlineValue(after)
			if found || !ok {
				return yamlValueSpan{}, false
			}
			start := line.offset + len(before) + 1
			span = yamlValueSpan{start + value.start, start + value.end}
			j := i + 1
			for j < len(lines) && lines[j].indent > indent {
				j++
			}
			block = lines[i+1 : j]
			found = true
		}
		if !found {
			return yamlValueSpan{}, false
		}
		if depth == len(path)-1 {
			return span, len(block) == 0
		}
		if span.start != span.end || len(block) == 0 {
			return yamlValueSpan{}, false
		}
		lines, indent = block, block[0].indent
	}
	return yamlValueSpan{}, false
}

func yamlInlineValue(text string) (yamlValueSpan, bool) {
	value := strings.TrimLeft(text, " \t")
	if value == "" || strings.HasPrefix(value, "#") {
		return yamlValueSpan{}, true
	}
	start := len(text) - len(value)
	switch quote := value[0]; quote {
	case '"', '\'':
		for i := 1; i < len(value); i++ {
			if quote == '"' && value[i] == '\\' {
				i++
				continue
			}
			if value[i] != quote {
				continue
			}
			if quote == '\'' && i+1 < len(value) && value[i+1] == quote {
				i++
				continue
			}
			tail := value[i+1:]
			trimmed := strings.TrimLeft(tail, " \t")
			return yamlValueSpan{start, start + i + 1}, trimmed == "" || (len(tail) > len(trimmed) && strings.HasPrefix(trimmed, "#"))
		}
		return yamlValueSpan{}, false
	case '[', '{', '|', '>', '&', '!', '*':
		return yamlValueSpan{}, false
	default:
		for i := 1; i < len(value); i++ {
			if value[i] == '#' && (value[i-1] == ' ' || value[i-1] == '\t') {
				value = value[:i]
				break
			}
		}
		return yamlValueSpan{start, start + len(strings.TrimRight(value, " \t"))}, true
	}
}
