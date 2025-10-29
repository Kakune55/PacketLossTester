package ws

import (
	"log"
	"net/http"
	"sync"
	"time"

	"pltester/datachannel"

	"github.com/pion/webrtc/v3"
	"golang.org/x/net/websocket"
)

// 连接管理器
type ConnectionManager struct {
	connections map[string]*webrtc.PeerConnection
	mutex       sync.RWMutex
}

var connManager = &ConnectionManager{
	connections: make(map[string]*webrtc.PeerConnection),
}

// WebSocketHandler 处理 WebSocket 连接
func WebSocketHandler(ws *websocket.Conn) {
	// 移除固定超时，改为使用心跳机制
	defer ws.Close()

	// 验证Origin
	if !validateOrigin(ws.Request()) {
		log.Printf("Invalid origin from %s", ws.Request().RemoteAddr)
		ws.WriteClose(http.StatusForbidden)
		return
	}

	// 为每个连接创建独立的PeerConnection
	peerConnection, err := datachannel.InitializePeerConnection()
	if err != nil {
		log.Printf("Failed to initialize peer connection: %v", err)
		ws.WriteClose(http.StatusInternalServerError)
		return
	}
	
	// 生成连接ID
	connID := generateConnectionID()
	
	// 注册连接
	connManager.registerConnection(connID, peerConnection)
	defer connManager.unregisterConnection(connID)

	datachannel.HandleICECandidate(peerConnection, ws)

	peerConnection.OnDataChannel(func(d *webrtc.DataChannel) {
		d.OnOpen(func() {
			log.Println("Data channel opened for connection:", connID)
		})
		d.OnMessage(func(msg webrtc.DataChannelMessage) {
			if err := d.SendText(string(msg.Data)); err != nil {
				log.Printf("Failed to send message for connection %s: %v", connID, err)
			}
		})
	})

	// 消息处理循环 - 支持长时间连接
	for {
		// 每次读取前重置超时时间（5分钟）
		ws.SetReadDeadline(time.Now().Add(5 * time.Minute))
		
		var msg string
		if err := websocket.Message.Receive(ws, &msg); err != nil {
			log.Printf("Can't receive from %s: %v", connID, err)
			return
		}
		
		// 验证消息大小
		if len(msg) > 1024*1024 { // 1MB限制
			log.Printf("Message too large from %s", connID)
			ws.WriteClose(http.StatusRequestEntityTooLarge)
			return
		}
		
		if err := datachannel.HandleSDP(peerConnection, msg, ws); err != nil {
			log.Printf("Failed to handle SDP for %s: %v", connID, err)
			return
		}
	}
}

// validateOrigin 验证请求来源
func validateOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	// 在生产环境中，应该检查具体的域名
	// 这里为了演示，允许所有来源，但实际使用时应该限制
	return origin != "" || r.Method == "GET"
}

// generateConnectionID 生成连接ID
func generateConnectionID() string {
	return time.Now().Format("20060102150405") + "-" +
		   string(rune(time.Now().UnixNano()%26+65)) +
		   string(rune(time.Now().UnixNano()%26+65))
}

// registerConnection 注册连接
func (cm *ConnectionManager) registerConnection(id string, pc *webrtc.PeerConnection) {
	cm.mutex.Lock()
	defer cm.mutex.Unlock()
	cm.connections[id] = pc
}

// unregisterConnection 注销连接
func (cm *ConnectionManager) unregisterConnection(id string) {
	cm.mutex.Lock()
	defer cm.mutex.Unlock()
	if pc, exists := cm.connections[id]; exists {
		pc.Close()
		delete(cm.connections, id)
	}
}

// GetConnection 获取连接
func (cm *ConnectionManager) GetConnection(id string) (*webrtc.PeerConnection, bool) {
	cm.mutex.RLock()
	defer cm.mutex.RUnlock()
	pc, exists := cm.connections[id]
	return pc, exists
}
