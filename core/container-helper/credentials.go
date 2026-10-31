package main

import (
	"encoding/json"
	"errors"
	"os"
	"strings"
)

const defaultCredentialsPath = "/run/lando/host-proxy/credentials"

var (
	errCredentialsRead = errors.New("Cannot read host-proxy credentials file. Restart the app with lando start.")
	errCredentialsInvalid = errors.New("Invalid host-proxy credentials file. Restart the app with lando start.")
	errCredentialsVersion = errors.New("Unsupported host-proxy credentials version. Restart the app with lando start.")
)

type proxyCredentials struct {
	Version int `json:"version"`
	App string `json:"app"`
	Session string `json:"session"`
	Token string `json:"token"`
}

// LANDO_HOST_PROXY_CREDENTIALS_FILE overrides only the file path for isolated tests.
// Credentials never fall back to environment variables, on either transport.
func readProxyCredentials(env map[string]string) (proxyCredentials, error) {
	path := env["LANDO_HOST_PROXY_CREDENTIALS_FILE"]
	if path == "" {
		path = defaultCredentialsPath
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return proxyCredentials{}, errCredentialsRead
	}
	var credentials proxyCredentials
	if err := json.Unmarshal(data, &credentials); err != nil {
		return proxyCredentials{}, errCredentialsInvalid
	}
	if credentials.Version != 1 {
		return proxyCredentials{}, errCredentialsVersion
	}
	for _, value := range []string{credentials.App, credentials.Session, credentials.Token} {
		if strings.TrimSpace(value) == "" || strings.ContainsAny(value, "\r\n") {
			return proxyCredentials{}, errCredentialsInvalid
		}
	}
	return credentials, nil
}
