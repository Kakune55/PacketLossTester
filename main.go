package main

import (
	"fmt"
	"log"
	"net/http"

	"pltester/config"
	"pltester/ws"

	"golang.org/x/net/websocket"
)

func main() {
	cfg, err := config.LoadConfig("etc/config.json")
	if err != nil {
		log.Fatalf("Failed to load configuration: %v", err)
	}

	// 添加CORS中间件
	mux := http.NewServeMux()
	mux.Handle("/ws", websocket.Handler(ws.WebSocketHandler))
	fs := http.FileServer(http.Dir("./static"))
	mux.Handle("/", fs)

	// 包装CORS中间件
	handler := corsMiddleware(mux)

	fmt.Printf("Server started at :%d\n", cfg.ListenPort)
	log.Fatal(http.ListenAndServe(fmt.Sprintf(":%d", cfg.ListenPort), handler))
}

// corsMiddleware 添加CORS头
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
