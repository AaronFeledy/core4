package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestProxyRejectsCredentials_whenFileUnavailableOrInvalid(t *testing.T) {
	for _, tc := range []struct {
		name, body, message string
	}{
		{"missing", "", errCredentialsRead.Error()},
		{"unreadable directory", "", errCredentialsRead.Error()},
		{"bad JSON", `{"token":"must-not-leak"`, errCredentialsInvalid.Error()},
		{"wrong version", `{"version":2,"app":"app","session":"session","token":"must-not-leak"}`, errCredentialsVersion.Error()},
		{"missing token", `{"version":1,"app":"app","session":"session"}`, errCredentialsInvalid.Error()},
		{"invalid header", `{"version":1,"app":"app","session":"session","token":"must-not-leak\n"}`, errCredentialsInvalid.Error()},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env := proxyEnv(t)
			path := filepath.Join(t.TempDir(), "credentials")
			env["LANDO_HOST_PROXY_CREDENTIALS_FILE"] = path
			env["LANDO_HOST_PROXY_TOKEN"] = "old-env-must-not-work"
			if tc.name == "unreadable directory" {
				env["LANDO_HOST_PROXY_CREDENTIALS_FILE"] = t.TempDir()
			} else if tc.body != "" {
				if err := os.WriteFile(path, []byte(tc.body), 0444); err != nil {
					t.Fatal(err)
				}
			}
			var out, stderr bytes.Buffer
			code := runHostProxy(context.Background(), nil, helperIO{strings.NewReader(""), &out, &stderr, env})
			if code != 127 || out.Len() != 0 || stderr.String() != tc.message+"\n" {
				t.Fatalf("code=%d stdout=%q stderr=%q", code, out.String(), stderr.String())
			}
		})
	}
}
