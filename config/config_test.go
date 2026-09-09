package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestIPAPIHostConfig(t *testing.T) {
	tests := []struct {
		name, host, want string
		invalid          bool
	}{
		{name: "default"},
		{name: "whitespace", host: "  "},
		{name: "bare host", host: "example.com/json", want: "https://example.com/json"},
		{name: "bare host URL query", host: "example.com/json?token=https://auth.example.com", want: "https://example.com/json?token=https://auth.example.com"},
		{name: "bare port", host: "localhost:8080/json?key=secret", want: "https://localhost:8080/json?key=secret"},
		{name: "path query", host: " https://example.com/proxy/json/?key=a%2Fb&key=c ", want: "https://example.com/proxy/json/?key=a%2Fb&key=c"},
		{name: "IPv6", host: "http://[::1]:8080/json", want: "http://[::1]:8080/json"},
		{name: "bare IPv6", host: "[::1]:8080/json", want: "https://[::1]:8080/json"},
		{name: "userinfo", host: "https://user:secret@example.com/json", want: "https://user:secret@example.com/json"},
		{name: "scheme", host: "ftp://example.com/json", invalid: true},
		{name: "opaque", host: "https:example.com", invalid: true},
		{name: "missing host", host: "https:///json", invalid: true},
		{name: "relative", host: "/json", invalid: true},
		{name: "scheme relative", host: "//example.com/json", invalid: true},
		{name: "space", host: "https://bad host/json", invalid: true},
		{name: "bad escape", host: "https://example.com/%zz", invalid: true},
		{name: "bad query", host: "https://example.com/?key=%zz", invalid: true},
		{name: "semicolon query", host: "https://example.com/?key=a;b", invalid: true},
		{name: "fragment", host: "https://example.com/json#secret", invalid: true},
		{name: "empty fragment", host: "https://example.com/json#", invalid: true},
		{name: "bad port", host: "https://example.com:abc", invalid: true},
		{name: "large port", host: "https://example.com:65536", invalid: true},
		{name: "empty port", host: "https://example.com:", invalid: true},
		{name: "zero port", host: "https://example.com:0", invalid: true},
		{name: "bad IPv6", host: "https://[bad]/json", invalid: true},
		{name: "unbracketed IPv6", host: "http://2001:4860:4860::8888/json", invalid: true},
		{name: "credential error", host: "https://user:secret@/json", invalid: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			u, err := ParseIPAPIHost(tt.host)
			if (err != nil) != tt.invalid {
				t.Fatalf("ParseIPAPIHost error = %v, invalid = %v", err, tt.invalid)
			}
			if err == nil && tt.want != "" && (u == nil || u.String() != tt.want) {
				t.Fatalf("URL = %v, want %s", u, tt.want)
			}
			if err == nil && tt.want == "" && u != nil {
				t.Fatalf("default URL = %v, want nil", u)
			}
			path := filepath.Join(t.TempDir(), "config.json")
			data, err := json.Marshal(Config{IPAPICustomHost: tt.host})
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, data, 0600); err != nil {
				t.Fatal(err)
			}
			_, err = LoadConfig(path)
			if (err != nil) != tt.invalid {
				t.Fatalf("LoadConfig error = %v, invalid = %v", err, tt.invalid)
			}
			if err != nil && (!strings.Contains(err.Error(), "ip_api_custom_host") || strings.Contains(err.Error(), "secret")) {
				t.Fatalf("unsafe or unhelpful error: %v", err)
			}
		})
	}
}
