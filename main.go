package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"

	"github.com/pion/webrtc/v3"
	"golang.org/x/net/websocket"
)

// Config 用于存储从配置文件加载的设置
type Config struct {
	ListenPort int `json:"listen_port"`
}


var peerConnection *webrtc.PeerConnection

func websocketHandler(ws *websocket.Conn) {
	defer ws.Close()

	config := webrtc.Configuration{}

	var err error
	peerConnection, err = webrtc.NewPeerConnection(config)
	if err != nil {
		log.Fatal(err)
	}

	peerConnection.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		candidate := c.ToJSON()
		candidateJSON, err := json.Marshal(candidate)
		if err != nil {
			log.Println("Failed to marshal ICE candidate:", err)
			return
		}
		if err := websocket.Message.Send(ws, string(candidateJSON)); err != nil {
			log.Println("Failed to send ICE candidate:", err)
		}
	})

	peerConnection.OnDataChannel(func(d *webrtc.DataChannel) {
		d.OnOpen(func() {
			log.Println("Data channel opened")
		})
		d.OnMessage(func(msg webrtc.DataChannelMessage) {
			// log.Printf("Message from DataChannel: %s\n", string(msg.Data))
			if err := d.SendText(string(msg.Data)); err != nil {
				log.Println("Failed to send message:", err)
			}
		})
	})

	for {
		var msg string
		if err := websocket.Message.Receive(ws, &msg); err != nil {
			log.Println("Can't receive:", err)
			break
		}

		var sdp webrtc.SessionDescription
		if err := json.Unmarshal([]byte(msg), &sdp); err != nil {
			log.Println("Failed to unmarshal SDP:", err)
			continue
		}

		if sdp.Type == webrtc.SDPTypeOffer {
			if err := peerConnection.SetRemoteDescription(sdp); err != nil {
				log.Println("Failed to set remote description:", err)
				continue
			}

			answer, err := peerConnection.CreateAnswer(nil)
			if err != nil {
				log.Println("Failed to create answer:", err)
				continue
			}

			if err := peerConnection.SetLocalDescription(answer); err != nil {
				log.Println("Failed to set local description:", err)
				continue
			}

			answerJSON, _:= json.Marshal(answer)
			if err := websocket.Message.Send(ws, string(answerJSON)); err != nil {
				log.Println("Failed to send answer:", err)
			}
		} else if sdp.Type == webrtc.SDPTypeAnswer {
			if err := peerConnection.SetRemoteDescription(sdp); err != nil {
				log.Println("Failed to set remote description:", err)
				continue
			}
		}
	}
}

	

func main() {
	// 检查配置文件是否存在
	if _, err := os.Stat("config.json"); os.IsNotExist(err) {
		// 如果不存在，则创建默认配置文件
		defaultConfig := Config{ListenPort: 8080}
		configData, err := json.MarshalIndent(defaultConfig, "", "  ")
		if err != nil {
			log.Fatalf("Failed to marshal default config: %v", err)
		}
		if err := os.WriteFile("config.json", configData, 0644); err != nil {
			log.Fatalf("Failed to write default config file: %v", err)
		}
		log.Println("Default config file created.")
	}

	// 加载并使用配置
	configData, err := os.ReadFile("config.json")
	if err != nil {
		log.Fatalf("Failed to read config file: %v", err)
	}
	var cfg Config
	if err := json.Unmarshal(configData, &cfg); err != nil {
		log.Fatalf("Failed to parse config data: %v", err)
	}

	// 使用配置文件中的端口
	http.Handle("/ws", websocket.Handler(websocketHandler))
	fs := http.FileServer(http.Dir("./static"))
	http.Handle("/", fs)

	fmt.Printf("Server started at :%d\n", cfg.ListenPort)
	log.Fatal(http.ListenAndServe(fmt.Sprintf(":%d", cfg.ListenPort), nil))
}
