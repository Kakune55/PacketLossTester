package config

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type Config struct {
	ListenPort      int    `json:"listen_port"`
	PublicIP        string `json:"public_ip,omitempty"`          // 公网IP，用于云服务器NAT环境
	UDPPortMin      uint16 `json:"udp_port_min,omitempty"`       // UDP端口范围最小值 (0表示随机)
	UDPPortMax      uint16 `json:"udp_port_max,omitempty"`       // UDP端口范围最大值 (0表示随机)
	IPAPICustomHost string `json:"ip_api_custom_host,omitempty"` // 可选 ip-api 兼容服务的基础 URL（包含 API 路径及认证查询参数）
}

func LoadConfig(path string) (Config, error) {
	defaultConfig := Config{
		ListenPort:      52611,
		PublicIP:        "", // 留空表示自动检测，或手动填写公网IP
		UDPPortMin:      0,  // 0表示使用随机端口
		UDPPortMax:      0,  // 0表示使用随机端口
		IPAPICustomHost: "",
	}

	// 检查配置文件是否存在
	if _, err := os.Stat(path); os.IsNotExist(err) {
		// 如果不存在，则创建默认配置文件
		if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
			return Config{}, fmt.Errorf("failed to create config directory: %w", err)
		}
		configData, err := json.MarshalIndent(defaultConfig, "", "  ")
		if err != nil {
			return Config{}, fmt.Errorf("failed to marshal default config: %w", err)
		}
		if err := os.WriteFile(path, configData, 0644); err != nil {
			return Config{}, fmt.Errorf("failed to write default config file: %w", err)
		}
		log.Println("Default config file created.")
		return defaultConfig, nil
	}

	// 加载并解析配置文件
	configData, err := os.ReadFile(path)
	if err != nil {
		return Config{}, fmt.Errorf("failed to read config file: %w", err)
	}
	var cfg Config
	if err := json.Unmarshal(configData, &cfg); err != nil {
		return Config{}, fmt.Errorf("failed to parse config data: %w", err)
	}
	if cfg.ListenPort == 0 {
		cfg.ListenPort = defaultConfig.ListenPort
	}
	if cfg.ListenPort < 1 || cfg.ListenPort > 65535 {
		return Config{}, fmt.Errorf("listen_port must be between 1 and 65535")
	}
	if (cfg.UDPPortMin == 0) != (cfg.UDPPortMax == 0) {
		return Config{}, fmt.Errorf("udp_port_min and udp_port_max must both be set or both be 0")
	}
	if cfg.UDPPortMin > 0 && cfg.UDPPortMax < cfg.UDPPortMin {
		return Config{}, fmt.Errorf("udp_port_max must be greater than or equal to udp_port_min")
	}
	if _, err := ParseIPAPIHost(cfg.IPAPICustomHost); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

// ParseIPAPIHost validates a custom endpoint without contacting the service.
// An empty value selects the default service; bare hosts use HTTPS.
func ParseIPAPIHost(value string) (*url.URL, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, nil
	}
	if schemeEnd := strings.Index(value, "://"); schemeEnd < 0 || strings.ContainsAny(value[:schemeEnd], "/?#") {
		value = "https://" + value
	}
	u, err := url.Parse(value)
	// Do not include the URL in errors: it may contain credentials.
	if err != nil {
		return nil, fmt.Errorf("ip_api_custom_host must be a valid HTTP(S) URL")
	}
	if (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.Opaque != "" {
		return nil, fmt.Errorf("ip_api_custom_host requires an HTTP(S) scheme and host")
	}
	if strings.ContainsAny(u.Hostname(), ":[]") && (net.ParseIP(u.Hostname()) == nil || !strings.HasPrefix(u.Host, "[")) {
		return nil, fmt.Errorf("ip_api_custom_host has an invalid IP host")
	}
	if strings.HasSuffix(u.Host, ":") {
		return nil, fmt.Errorf("ip_api_custom_host has an empty port")
	}
	if port := u.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			return nil, fmt.Errorf("ip_api_custom_host port must be between 1 and 65535")
		}
	}
	if strings.Contains(value, "#") {
		return nil, fmt.Errorf("ip_api_custom_host must not contain a fragment")
	}
	if _, err := url.ParseQuery(u.RawQuery); err != nil {
		return nil, fmt.Errorf("ip_api_custom_host has an invalid query")
	}
	return u, nil
}
