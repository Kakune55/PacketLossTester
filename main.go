package main

import (
	"embed"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"strings"
	"time"

	"pltester/config"
	"pltester/ipinfo"
	"pltester/nodes"
	"pltester/speedtest"
	"pltester/ws"

	"golang.org/x/net/websocket"
)

//go:embed static
var staticFS embed.FS

func getLocalIP() string {
	conn, err := net.Dial("udp", "8.8.8.8:80")
	if err != nil {
		return "localhost"
	}
	defer conn.Close()

	localAddr := conn.LocalAddr()
	if udpAddr, ok := localAddr.(*net.UDPAddr); ok {
		if ip := udpAddr.IP; ip != nil {
			return ip.String()
		}
	}
	return "localhost"
}
func main() {
	cfg, err := config.LoadConfig("etc/config.json")
	if err != nil {
		log.Fatalf("Failed to load configuration: %v", err)
	}

	// 设置公网IP（如果配置了）
	if cfg.PublicIP != "" {
		ws.SetPublicIP(cfg.PublicIP)
		log.Printf("Public IP configured: %s", cfg.PublicIP)
	} else {
		log.Println("No public IP configured, using automatic NAT traversal")
	}

	// 设置UDP端口范围（如果配置了）
	if cfg.UDPPortMin > 0 && cfg.UDPPortMax > 0 {
		ws.SetUDPPortRange(cfg.UDPPortMin, cfg.UDPPortMax)
		log.Printf("UDP port range configured: %d-%d", cfg.UDPPortMin, cfg.UDPPortMax)
	} else {
		log.Println("No UDP port range configured, using random ports")
	}

	// 添加CORS中间件
	ipService := ipinfo.NewService(cfg.PublicIP, cfg.IPAPICustomHost)

	mux := http.NewServeMux()
	mux.Handle("/ws", websocket.Handler(ws.WebSocketHandler))
	mux.HandleFunc("/speedtest/download", speedtest.DownloadHandler)
	mux.HandleFunc("/speedtest/upload", speedtest.UploadHandler)
	mux.HandleFunc("/speedtest/ping", speedtest.PingHandler)
	mux.HandleFunc("/api/ipinfo", ipService.Handler())
	mux.HandleFunc("/api/nodes", nodes.Handler(cfg.Nodes))

	// 使用嵌入的文件系统
	staticSub, err := fs.Sub(staticFS, "static")
	if err != nil {
		log.Fatalf("Failed to get static subdirectory: %v", err)
	}
	fs := http.FileServer(http.FS(staticSub))
	mux.Handle("/", fs)

	// 包装CORS中间件
	handler := corsMiddleware(mux, cfg)

	fmt.Printf("Server started at :%d\n", cfg.ListenPort)
	log.Println("Open http://localhost:" + fmt.Sprint(cfg.ListenPort) + " in your browser")
	log.Println("LAN Address: http://" + getLocalIP() + ":" + fmt.Sprint(cfg.ListenPort))
	log.Println("Press Ctrl+C to stop the server")
	server := &http.Server{
		Addr:              fmt.Sprintf(":%d", cfg.ListenPort),
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	log.Fatal(server.ListenAndServe())
}
func corsMiddleware(next http.Handler, cfg config.Config) http.Handler {
	origins := cfg.AllowedOrigins
	if origins == nil {
		origins = []string{"*"}
	}
	allowedOrigins := make(map[string]bool, len(origins))
	for _, origin := range origins {
		allowedOrigins[origin] = true
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reject := func(message string) {
			r.Close = true
			w.Header().Set("Connection", "close")
			http.Error(w, message, http.StatusForbidden)
		}
		if !allowedOrigins["*"] {
			w.Header().Add("Vary", "Origin")
		}
		origin := r.Header.Get("Origin")
		originValues := r.Header.Values("Origin")
		if len(originValues) > 0 && !allowedOrigins["*"] && (len(originValues) != 1 || !allowedOrigins[origin]) {
			reject("origin not allowed")
			return
		}

		if r.Method == http.MethodOptions {
			if r.ContentLength != 0 || len(r.TransferEncoding) != 0 {
				r.Close = true
				w.Header().Set("Connection", "close")
			}
			w.Header().Add("Vary", "Access-Control-Request-Method")
			w.Header().Add("Vary", "Access-Control-Request-Headers")
			switch strings.Join(r.Header.Values("Access-Control-Request-Method"), ",") {
			case "", http.MethodGet, http.MethodPost, http.MethodPut, http.MethodOptions:
			default:
				reject("preflight method not allowed")
				return
			}
			for _, header := range strings.Split(strings.Join(r.Header.Values("Access-Control-Request-Headers"), ","), ",") {
				switch strings.ToLower(strings.TrimSpace(header)) {
				case "", "content-type", "authorization":
				default:
					reject("preflight header not allowed")
					return
				}
			}
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		}
		if allowedOrigins["*"] {
			w.Header().Set("Access-Control-Allow-Origin", "*")
		} else if origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
		}
		w.Header().Set("Access-Control-Expose-Headers", "Retry-After")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}

		next.ServeHTTP(w, r)
	})
}
