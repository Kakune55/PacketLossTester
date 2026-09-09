package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func loadTestConfig(t *testing.T, data string) (Config, error) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(data), 0600); err != nil {
		t.Fatal(err)
	}
	return LoadConfig(path)
}

func TestNodeDefaults(t *testing.T) {
	for _, data := range []string{`{}`, `{"nodes":null}`, `{"nodes":[]}`} {
		t.Run(data, func(t *testing.T) {
			cfg, err := loadTestConfig(t, data)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(cfg.Nodes, DefaultNodes()) || !reflect.DeepEqual(cfg.AllowedOrigins, []string{"*"}) {
				t.Fatalf("unexpected defaults: %+v", cfg)
			}
		})
	}
	t.Run("missing file", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "config.json")
		cfg, err := LoadConfig(path)
		if err != nil {
			t.Fatal(err)
		}
		loaded, err := LoadConfig(path)
		if err != nil || !reflect.DeepEqual(cfg, loaded) || !reflect.DeepEqual(cfg.Nodes, DefaultNodes()) || !reflect.DeepEqual(cfg.AllowedOrigins, []string{"*"}) {
			t.Fatalf("default config round trip: %+v, %+v, %v", cfg, loaded, err)
		}
	})
}

func TestNodeValidation(t *testing.T) {
	tests := []struct {
		name, nodes string
		invalid     bool
	}{
		{"local", `[{"id":"local","name":"本机节点"}]`, false},
		{"external prefix", `[{"id":"US_east-1","name":"East","region":"US","baseUrl":"https://example.com/proxy///","capabilities":["speedtest"]}]`, false},
		{"empty id", `[{"name":"Local"}]`, true},
		{"unicode id", `[{"id":"本机","name":"Local"}]`, true},
		{"space id", `[{"id":"a b","name":"Local"}]`, true},
		{"slash id", `[{"id":"a/b","name":"Local"}]`, true},
		{"dot id", `[{"id":"a.b","name":"Local"}]`, true},
		{"duplicate id", `[{"id":"a","name":"One"},{"id":"a","name":"Two"}]`, true},
		{"missing name", `[{"id":"a"}]`, true},
		{"blank name", `[{"id":"a","name":"  "}]`, true},
		{"empty capabilities", `[{"id":"a","name":"A","capabilities":[]}]`, true},
		{"unknown capability", `[{"id":"a","name":"A","capabilities":["ping"]}]`, true},
		{"duplicate capability", `[{"id":"a","name":"A","capabilities":["packetloss","packetloss"]}]`, true},
		{"two nodes", `[{"id":"a","name":"A","capabilities":["packetloss"]},{"id":"b","name":"B","baseUrl":"http://example.com/"}]`, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg, err := loadTestConfig(t, `{"nodes":`+tt.nodes+`}`)
			if (err != nil) != tt.invalid {
				t.Fatalf("error = %v, invalid = %v", err, tt.invalid)
			}
			if tt.invalid {
				if !strings.Contains(err.Error(), "nodes[") {
					t.Fatalf("unhelpful error: %v", err)
				}
				return
			}
			if tt.name == "local" && !reflect.DeepEqual(cfg.Nodes, DefaultNodes()) {
				t.Fatalf("unexpected local defaults: %+v", cfg.Nodes)
			}
			if tt.name == "external prefix" && (cfg.Nodes[0].BaseURL != "https://example.com/proxy" || cfg.Nodes[0].ID != "US_east-1" || cfg.Nodes[0].Region != "US" || !reflect.DeepEqual(cfg.Nodes[0].Capabilities, []string{"speedtest"})) {
				t.Fatalf("unexpected normalized node: %+v", cfg.Nodes[0])
			}
		})
	}
}

func TestNodeURLValidation(t *testing.T) {
	tests := []struct {
		url, want string
	}{
		{"", ""},
		{"http://localhost:8080/", "http://localhost:8080"},
		{"https://example.com/prefix///", "https://example.com/prefix"},
		{"https://example.com/a%2Fb/", "https://example.com/a%2Fb"},
		{"http://[::1]:65535/prefix/", "http://[::1]:65535/prefix"},
	}
	for _, tt := range tests {
		t.Run(tt.url, func(t *testing.T) {
			data, err := json.Marshal(Config{Nodes: []Node{{ID: "a", Name: "A", BaseURL: tt.url}}})
			if err != nil {
				t.Fatal(err)
			}
			cfg, err := loadTestConfig(t, string(data))
			if err != nil || cfg.Nodes[0].BaseURL != tt.want {
				t.Fatalf("nodes = %+v, error = %v, want %q", cfg.Nodes, err, tt.want)
			}
		})
	}
	for _, value := range []string{
		"example.com", "//example.com", "/prefix", "ftp://example.com", "https:example.com", "https:///prefix",
		"https://bad host", "https://example.com/%zz", "https://user:secret@example.com",
		"https://example.com?token=secret", "https://example.com?", "https://example.com#secret", "https://example.com#",
		"https://example.com:abc", "https://example.com:", "https://example.com:0", "https://example.com:65536", "https://example.com:-1",
		"https://[bad]", "http://2001:db8::1", "https://user:secret@/prefix", " https://example.com", "https://example.com/ ",
	} {
		t.Run(value, func(t *testing.T) {
			data, err := json.Marshal(Config{Nodes: []Node{{ID: "a", Name: "A", BaseURL: value}}})
			if err != nil {
				t.Fatal(err)
			}
			_, err = loadTestConfig(t, string(data))
			if err == nil || !strings.Contains(err.Error(), "baseUrl") || strings.Contains(err.Error(), "secret") || strings.Contains(err.Error(), value) {
				t.Fatalf("expected safe baseUrl error, got %v", err)
			}
		})
	}
}

func TestAllowedOriginsValidation(t *testing.T) {
	for _, tt := range []struct {
		name    string
		origins []string
		invalid bool
	}{
		{"omitted", nil, false},
		{"deny browsers", []string{}, false},
		{"wildcard", []string{"*"}, false},
		{"origins", []string{"https://example.com", "http://localhost:8080", "https://[::1]"}, false},
		{"empty", []string{""}, true},
		{"null origin", []string{"null"}, true},
		{"relative", []string{"//example.com"}, true},
		{"scheme", []string{"ftp://example.com"}, true},
		{"path", []string{"https://example.com/prefix"}, true},
		{"root path", []string{"https://example.com/"}, true},
		{"query", []string{"https://example.com?secret"}, true},
		{"empty query", []string{"https://example.com?"}, true},
		{"fragment", []string{"https://example.com#secret"}, true},
		{"empty fragment", []string{"https://example.com#"}, true},
		{"auth", []string{"https://user:secret@example.com"}, true},
		{"port", []string{"https://example.com:65536"}, true},
		{"empty port", []string{"https://example.com:"}, true},
		{"host", []string{"https://[bad]"}, true},
		{"subdomain wildcard", []string{"https://*.example.com"}, true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			data, err := json.Marshal(Config{AllowedOrigins: tt.origins})
			if err != nil {
				t.Fatal(err)
			}
			cfg, err := loadTestConfig(t, string(data))
			if (err != nil) != tt.invalid {
				t.Fatalf("error = %v, invalid = %v", err, tt.invalid)
			}
			if err != nil {
				if !strings.Contains(err.Error(), "allowed_origins[") || strings.Contains(err.Error(), "secret") {
					t.Fatalf("unsafe or unhelpful error: %v", err)
				}
			} else if tt.origins != nil && !reflect.DeepEqual(cfg.AllowedOrigins, tt.origins) {
				t.Fatalf("origins = %#v, want %#v", cfg.AllowedOrigins, tt.origins)
			}
		})
	}
}
