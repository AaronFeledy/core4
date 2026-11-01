package main

import (
	"reflect"
	"testing"
)

func TestEnvPolicy(t *testing.T) {
	for _, tc := range []struct {
		name   string
		policy envPolicy
		want   map[string]string
	}{
		{"empty", envPolicy{}, map[string]string{}},
		{"prefix", envPolicy{prefixes: []string{"LANDO_", "LC_"}}, map[string]string{"LC_ALL": "C"}},
		{"names", envPolicy{names: parseNames("LANG,TERM,,GROK_AGENT")}, map[string]string{"LANG": "en", "TERM": "xterm", "GROK_AGENT": "true"}},
		{"blocked wins", envPolicy{prefixes: []string{"LANDO_"}, names: parseNames("LANDO_TOKEN"), blocked: parseNames("LANDO_TOKEN")}, map[string]string{}},
		{"one only", envPolicy{names: parseNames("GROK_AGENT,ONE,ZERO"), oneOnly: parseNames("GROK_AGENT,ONE,ZERO")}, map[string]string{"ONE": "1"}},
		{"one only does not allow", envPolicy{oneOnly: parseNames("ONE")}, map[string]string{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env := map[string]string{"LANDO_FOO": "", "LC_ALL": "C", "LANDO_TOKEN": "secret", "LANG": "en", "TERM": "xterm", "GROK_AGENT": "true", "ONE": "1", "ZERO": "0", "PATH": "/bin", "lang": "wrong"}
			got := tc.policy.filter(env)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("filter = %#v, want %#v", got, tc.want)
			}
		})
	}
}

func TestLinkedPolicyParsing(t *testing.T) {
	old := []string{forwardPrefixes, forwardNames, blockedNames, mustBeOneNames}
	t.Cleanup(func() { forwardPrefixes, forwardNames, blockedNames, mustBeOneNames = old[0], old[1], old[2], old[3] })
	forwardPrefixes, forwardNames, blockedNames, mustBeOneNames = ",LANDO_,,LC_,", "LANG,GROK_AGENT", "LANDO_HOST_PROXY_TOKEN", "GROK_AGENT"
	got := parsePolicy().filter(map[string]string{"LANDO_X": "x", "LC_ALL": "C", "LANG": "en", "GROK_AGENT": "1", "LANDO_HOST_PROXY_TOKEN": "secret", "OTHER": "no"})
	want := map[string]string{"LC_ALL": "C", "LANG": "en", "GROK_AGENT": "1"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("filter = %#v, want %#v", got, want)
	}
}

func TestDepthNumberConversion(t *testing.T) {
	for _, tc := range []struct{ input, want string }{
		{"", "0"}, {"  \ufeff", "0"}, {"nonsense", "0"}, {"NaN", "0"}, {"Infinity", "0"}, {"1e999", "0"},
		{"-0", "0"}, {"  +2.5 ", "2.5"}, {".5", "0.5"}, {"1.", "1"}, {"1e3", "1000"}, {"1e-7", "0.0000001"},
		{"0xff", "255"}, {"0b101", "5"}, {"0o10", "8"}, {"-0xff", "0"}, {"0x1_0", "0"}, {"0b2", "0"}, {"01", "1"}, {"1_000", "0"}, {"0x1p2", "0"},
	} {
		t.Run(tc.input, func(t *testing.T) {
			if got := parseDepth(tc.input); got != tc.want {
				t.Fatalf("depth = %q, want %q", got, tc.want)
			}
		})
	}
}
