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

// websocketHandler处理WebSocket连接，用于建立和管理WebRTC的peer连接。
func websocketHandler(ws *websocket.Conn) {
    // 关闭WebSocket连接的defer语句
    defer ws.Close()

    // 配置WebRTC，添加STUN服务器
	// 这里使用了一个公开的STUN服务器地址作为示例，请根据实际情况选择或使用自己的STUN服务器
	config := webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{
			{
				URLs: []string{"stun:stun.l.google.com:19302","stun:stun01.sipphone.com"},
			},
		},
	}
	
    // 创建新的peer连接，如果出错则记录错误并终止程序
    var err error
    peerConnection, err = webrtc.NewPeerConnection(config)
    if err != nil {
        log.Fatal(err)
    }

    // 当有ICE候选时，将其发送给对端
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

    // 当有新的数据通道打开时，处理该通道的消息
    peerConnection.OnDataChannel(func(d *webrtc.DataChannel) {
        d.OnOpen(func() {
            log.Println("Data channel opened")
        })
        d.OnMessage(func(msg webrtc.DataChannelMessage) {
            // 注释掉的代码表示曾经用于日志记录
            // log.Printf("Message from DataChannel: %s\n", string(msg.Data))
            if err := d.SendText(string(msg.Data)); err != nil {
                log.Println("Failed to send message:", err)
            }
        })
    })

    // 无限循环，接收和处理WebSocket消息
    for {
        var msg string
        // 接收WebSocket消息，如果出错则记录错误并退出循环
        if err := websocket.Message.Receive(ws, &msg); err != nil {
            log.Println("Can't receive:", err)
            break
        }

        // 解析接收到的SDP消息
        var sdp webrtc.SessionDescription
        if err := json.Unmarshal([]byte(msg), &sdp); err != nil {
            log.Println("Failed to unmarshal SDP:", err)
            continue
        }

        // 根据SDP的类型，处理offer或answer
        if sdp.Type == webrtc.SDPTypeOffer {
            // 设置远程描述，然后创建answer并设置为本地描述
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

            answerJSON, _ := json.Marshal(answer)
            // 发送answer给对端
            if err := websocket.Message.Send(ws, string(answerJSON)); err != nil {
                log.Println("Failed to send answer:", err)
            }
        } else if sdp.Type == webrtc.SDPTypeAnswer {
            // 设置远程描述
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
