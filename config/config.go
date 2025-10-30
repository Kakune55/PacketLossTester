package config

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
)

type Config struct {
	ListenPort int `json:"listen_port"`
}

func LoadConfig(path string) (Config, error) {
	// 检查配置文件是否存在
	if _, err := os.Stat(path); os.IsNotExist(err) {
		// 如果不存在，则创建默认配置文件
		if err := os.MkdirAll("etc", 0755); err != nil {
			return Config{}, fmt.Errorf("failed to create config directory: %w", err)
		}
		defaultConfig := Config{ListenPort: 52611}
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
	return cfg, nil
}
