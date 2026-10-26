package main

import (
	"bytes"
	"errors"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestOpenCallClassifiesTarget(t *testing.T) {
	for _, target := range []string{"https://example.com/x", "mailto:dev@example.com", "vscode://file/app"} {
		t.Run(target, func(t *testing.T) {
			call, err := openCall([]string{target})
			if err != nil || call.operation != "openUrl" || !reflect.DeepEqual(call.payload, openURLRequest{"openUrl", target}) {
				t.Fatalf("call=%+v err=%v", call, err)
			}
		})
	}
	for _, target := range []string{"./README", "/app/README", "../README", "a b"} {
		t.Run(target, func(t *testing.T) {
			want, err := filepath.Abs(target)
			if err != nil {
				t.Fatal(err)
			}
			call, err := openCall([]string{target})
			if err != nil || call.operation != "openPath" || !reflect.DeepEqual(call.payload, openPathRequest{"openPath", want}) {
				t.Fatalf("call=%+v err=%v", call, err)
			}
		})
	}
}

func TestOpenCallRejectsFlagsAndArgumentCount(t *testing.T) {
	for _, args := range [][]string{nil, {""}, {"-a", "Safari"}, {"--help"}, {"a", "b"}, {"--", "a"}} {
		_, err := openCall(args)
		if !errors.Is(err, errOpenArguments) {
			t.Fatalf("args=%q err=%v", args, err)
		}
	}
}

func TestOpenRolesAndMissingProxy(t *testing.T) {
	for _, role := range []string{"/usr/local/bin/xdg-open", "/usr/local/bin/open"} {
		var stdout, stderr bytes.Buffer
		code := dispatch(role, []string{"https://example.com"}, helperIO{strings.NewReader(""), &stdout, &stderr, map[string]string{}})
		if code != 127 || stderr.String() != "Missing LANDO_HOST_PROXY_SOCKET or LANDO_HOST_PROXY_URL for host-proxy openUrl.\n" {
			t.Fatalf("role=%s code=%d stderr=%q", role, code, stderr.String())
		}
	}
}

func TestOpenResponseUnion(t *testing.T) {
	for _, fixture := range []struct {
		wire   string
		code   int
		stderr string
	}{
		{`{"_tag":"ok"}`, 0, ""},
		{`{"_tag":"error","code":"scheme-not-allowed","message":"rejected","remediation":"Use HTTPS."}`, 1, "scheme-not-allowed: rejected\nUse HTTPS.\n"},
	} {
		var stdout, stderr bytes.Buffer
		code, err := readOpenResponse(strings.NewReader(fixture.wire), helperIO{strings.NewReader(""), &stdout, &stderr, nil})
		if err != nil || code != fixture.code || stderr.String() != fixture.stderr {
			t.Fatalf("code=%d err=%v stderr=%q", code, err, stderr.String())
		}
	}
}
