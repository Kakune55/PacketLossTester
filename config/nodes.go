package config

import (
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
	"unicode"

	"golang.org/x/net/idna"
)

type Node struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Region       string   `json:"region,omitempty"`
	BaseURL      string   `json:"baseUrl"`
	Capabilities []string `json:"capabilities"`
}

func DefaultNodes() []Node {
	return []Node{{ID: "local", Name: "本机节点", BaseURL: "", Capabilities: []string{"packetloss", "speedtest"}}}
}

func (cfg *Config) validateNodesAndOrigins() error {
	if len(cfg.Nodes) == 0 {
		cfg.Nodes = DefaultNodes()
	}
	ids := make(map[string]bool, len(cfg.Nodes))
	for i := range cfg.Nodes {
		node := &cfg.Nodes[i]
		if node.ID == "" || strings.IndexFunc(node.ID, func(c rune) bool {
			return !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_')
		}) >= 0 {
			return fmt.Errorf("nodes[%d].id must contain only ASCII letters, digits, hyphens or underscores", i)
		}
		if ids[node.ID] {
			return fmt.Errorf("nodes[%d].id must be unique", i)
		}
		ids[node.ID] = true
		if strings.TrimSpace(node.Name) == "" {
			return fmt.Errorf("nodes[%d].name must not be empty", i)
		}
		if node.Capabilities == nil {
			node.Capabilities = []string{"packetloss", "speedtest"}
		}
		if len(node.Capabilities) == 0 {
			return fmt.Errorf("nodes[%d].capabilities must not be empty", i)
		}
		seen := make(map[string]bool, 2)
		for _, capability := range node.Capabilities {
			if (capability != "packetloss" && capability != "speedtest") || seen[capability] {
				return fmt.Errorf("nodes[%d].capabilities must contain only packetloss or speedtest without duplicates", i)
			}
			seen[capability] = true
		}
		if node.BaseURL != "" {
			if !validHTTPURL(node.BaseURL, false) {
				return fmt.Errorf("nodes[%d].baseUrl must be an absolute HTTP(S) URL with a valid host and port, without userinfo, query or fragment", i)
			}
			node.BaseURL = strings.TrimRight(node.BaseURL, "/")
		}
	}
	if cfg.AllowedOrigins == nil {
		cfg.AllowedOrigins = []string{"*"}
	}
	for i, origin := range cfg.AllowedOrigins {
		if origin == "*" {
			continue
		}
		if !validHTTPURL(origin, true) {
			return fmt.Errorf("allowed_origins[%d] must be * or an HTTP(S) origin without path, userinfo, query or fragment", i)
		}
		u, _ := url.Parse(origin)
		host := u.Hostname()
		if ip := net.ParseIP(host); ip != nil {
			if strings.Contains(host, ":") {
				host = ip.String()
				if v4 := ip.To4(); v4 != nil {
					host = fmt.Sprintf("::ffff:%x:%x", uint16(v4[0])<<8|uint16(v4[1]), uint16(v4[2])<<8|uint16(v4[3]))
				}
				host = "[" + host + "]"
			} else {
				host = ip.String()
			}
		} else {
			var err error
			host, err = idna.Lookup.ToASCII(host)
			if err != nil {
				return fmt.Errorf("allowed_origins[%d] has an invalid host", i)
			}
		}
		port, _ := strconv.Atoi(u.Port())
		if port != 0 && !(u.Scheme == "https" && port == 443 || u.Scheme == "http" && port == 80) {
			host += ":" + strconv.Itoa(port)
		}
		cfg.AllowedOrigins[i] = u.Scheme + "://" + strings.ToLower(host)
	}
	return nil
}

// Never return URL parser errors: they can disclose credentials from bad config.
func validHTTPURL(value string, origin bool) bool {
	u, err := url.Parse(value)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.Opaque != "" || u.User != nil || strings.ContainsAny(value, "?#") || strings.IndexFunc(value, unicode.IsSpace) >= 0 {
		return false
	}
	if strings.Contains(u.Host, "*") {
		return false
	}
	if origin && u.Path != "" {
		return false
	}
	if (strings.HasPrefix(u.Host, "[") || strings.ContainsAny(u.Hostname(), ":[]")) && (net.ParseIP(u.Hostname()) == nil || !strings.HasPrefix(u.Host, "[")) {
		return false
	}
	if strings.HasPrefix(u.Host, "[") && !strings.Contains(u.Hostname(), ":") {
		return false
	}
	if strings.HasSuffix(u.Host, ":") {
		return false
	}
	if port := u.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			return false
		}
	}
	return true
}
