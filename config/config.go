package config

import (
	"encoding/json"
	"log"
	"os"
)

type Config struct {
	ListenPort int `json:"listen_port"`
}

func LoadConfig(path string) Config {
	// 检查配置文件是否存在
	if _, err := os.Stat(path); os.IsNotExist(err) {
		// 如果不存在，则创建默认配置文件
		defaultConfig := Config{ListenPort: 8080}
		configData, err := json.MarshalIndent(defaultConfig, "", "  ")
		if err != nil {
			log.Fatalf("Failed to marshal default config: %v", err)
		}
		if err := os.WriteFile(path, configData, 0644); err != nil {
			log.Fatalf("Failed to write default config file: %v", err)
		}
		log.Println("Default config file created.")
		return defaultConfig
	}

	// 加载并解析配置文件
	configData, err := os.ReadFile(path)
	if err != nil {
		log.Fatalf("Failed to read config file: %v", err)
	}
	var cfg Config
	if err := json.Unmarshal(configData, &cfg); err != nil {
		log.Fatalf("Failed to parse config data: %v", err)
	}
	return cfg
}
