package main

import "strings"

// Set by the TypeScript build with -ldflags '-X main.<name>=<csv>'.
var forwardPrefixes, forwardNames, blockedNames, mustBeOneNames string

type envPolicy struct {
	prefixes []string
	names    map[string]bool
	blocked  map[string]bool
	oneOnly  map[string]bool
}

func parseNames(csv string) map[string]bool {
	names := make(map[string]bool)
	for _, name := range strings.Split(csv, ",") {
		if name != "" {
			names[name] = true
		}
	}
	return names
}

func parsePolicy() envPolicy {
	var prefixes []string
	for _, prefix := range strings.Split(forwardPrefixes, ",") {
		if prefix != "" {
			prefixes = append(prefixes, prefix)
		}
	}
	return envPolicy{prefixes, parseNames(forwardNames), parseNames(blockedNames), parseNames(mustBeOneNames)}
}

func (p envPolicy) filter(env map[string]string) map[string]string {
	result := make(map[string]string)
	for name, value := range env {
		if p.blocked[name] || (p.oneOnly[name] && value != "1") {
			continue
		}
		allowed := p.names[name]
		for _, prefix := range p.prefixes {
			allowed = allowed || strings.HasPrefix(name, prefix)
		}
		if allowed {
			result[name] = value
		}
	}
	return result
}
