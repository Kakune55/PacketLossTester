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
	cfg := config.LoadConfig("etc/config.json")

	http.Handle("/ws", websocket.Handler(ws.WebSocketHandler))
	fs := http.FileServer(http.Dir("./static"))
	http.Handle("/", fs)

	fmt.Printf("Server started at :%d\n", cfg.ListenPort)
	log.Fatal(http.ListenAndServe(fmt.Sprintf(":%d", cfg.ListenPort), nil))
}
