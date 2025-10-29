package main

import (
	"embed"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"

	"pltester/config"
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

	// 添加CORS中间件
	mux := http.NewServeMux()
	mux.Handle("/ws", websocket.Handler(ws.WebSocketHandler))
	
	// 使用嵌入的文件系统
	staticSub, err := fs.Sub(staticFS, "static")
	if err != nil {
		log.Fatalf("Failed to get static subdirectory: %v", err)
	}
	fs := http.FileServer(http.FS(staticSub))
	mux.Handle("/", fs)

	// 包装CORS中间件
	handler := corsMiddleware(mux)

	fmt.Printf("Server started at :%d\n", cfg.ListenPort)
	log.Println("Open http://localhost:" + fmt.Sprint(cfg.ListenPort) + " in your browser")
	log.Println("LAN Address: http://" + getLocalIP() + ":" + fmt.Sprint(cfg.ListenPort))
	log.Println("Press Ctrl+C to stop the server")
	log.Fatal(http.ListenAndServe(fmt.Sprintf(":%d", cfg.ListenPort), handler))
}
func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}
		
		next.ServeHTTP(w, r)
	})
}
