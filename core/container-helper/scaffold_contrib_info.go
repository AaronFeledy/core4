package main

import (
	"encoding/json"
	"regexp"
	"strings"
)

var infoQuotedScalar = regexp.MustCompile(`^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')(?:[ \t]+#.*)?$`)

func yamlRootString(text, key string) string {
	var value string
	var seenKey, seenDocument bool
	for _, line := range strings.Split(strings.TrimPrefix(text, "\ufeff"), "\n") {
		line = strings.TrimRight(line, " \t\r")
		if line == "" || strings.ContainsRune(" \t#%", rune(line[0])) {
			continue
		}
		marker := strings.Fields(line)[0]
		if marker == "..." || marker == "---" && seenDocument {
			break
		}
		seenDocument = true
		name, raw, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		switch strings.TrimRight(name, " \t") {
		case key, `"` + key + `"`, "'" + key + "'":
		default:
			continue
		}
		if seenKey || raw == "" || raw[0] != ' ' && raw[0] != '\t' {
			return ""
		}
		seenKey = true
		raw = strings.TrimSpace(raw)
		if raw == "" {
			return ""
		}
		switch raw[0] {
		case '"', '\'':
			match := infoQuotedScalar.FindStringSubmatch(raw)
			if match == nil {
				return ""
			}
			quoted := match[1]
			if quoted[0] == '\'' {
				value = strings.ReplaceAll(quoted[1:len(quoted)-1], "''", "'")
			} else if json.Unmarshal([]byte(quoted), &value) != nil {
				return ""
			}
		case '#', '[', '{', '|', '>', '&', '!', '*':
			return ""
		default:
			for i := 1; i < len(raw); i++ {
				if raw[i] == '#' && (raw[i-1] == ' ' || raw[i-1] == '\t') {
					raw = raw[:i]
					break
				}
			}
			value = strings.TrimSpace(raw)
		}
	}
	return value
}
