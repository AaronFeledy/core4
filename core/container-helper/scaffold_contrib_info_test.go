package main

import "testing"

func TestInfoRootType(t *testing.T) {
	for _, tc := range []struct{ info, want string }{
		{"\ufeff--- # metadata\r\ntype: module # comment\r\n", "module"},
		{"extra:\n  type: module\n\"type\": \"theme\" # comment\n", "theme"},
		{"type: 'profile' # comment", "profile"},
		{"type: 'module # value' # comment", "module # value"},
		{"extra:\n  type: module\n", ""},
		{"type: module\n...\n---\ntype: theme\n", "module"},
		{"type: module\ntype: theme\n", ""},
	} {
		if got := yamlRootString(tc.info, "type"); got != tc.want {
			t.Errorf("type for %q = %q, want %q", tc.info, got, tc.want)
		}
	}
}
