package ws

import (
	"crypto/rand"
	"errors"
	"log"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"pltester/datachannel"

	"github.com/pion/webrtc/v3"
	"golang.org/x/net/websocket"
)

const (
	maxSignalBytes       = 1 << 20
	maxDataChannels      = 1
	writeTimeout         = datachannel.SignalWriteTimeout
	pingInterval         = 30 * time.Second
	closePolicyViolation = 1008
	closeMessageTooBig   = 1009
	closeInternalError   = 1011
	closeOverloaded      = 1013
)

var pingCodec = websocket.Codec{
	Marshal: func(interface{}) ([]byte, byte, error) {
		return nil, websocket.PingFrame, nil
	},
}

// Pong frames are consumed internally by x/net/websocket, not returned by
// Receive. A fixed read deadline would kill healthy, idle signaling sessions.
func keepAlive(ws *websocket.Conn, interval time.Duration) func() {
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				if err := ws.SetWriteDeadline(time.Now().Add(writeTimeout)); err != nil {
					ws.Close()
					return
				}
				if err := pingCodec.Send(ws, nil); err != nil {
					ws.Close()
					return
				}
			}
		}
	}()
	return func() {
		close(stop)
		<-done
	}
}

// 连接管理器
type ConnectionManager struct {
	connections map[string]*webrtc.PeerConnection
	mutex       sync.RWMutex
	publicIP    string // 公网IP配置
	udpPortMin  uint16 // UDP端口范围最小值
	udpPortMax  uint16 // UDP端口范围最大值
}

var connManager = &ConnectionManager{
	connections: make(map[string]*webrtc.PeerConnection),
}

// SetPublicIP 设置公网IP
func SetPublicIP(ip string) {
	connManager.mutex.Lock()
	defer connManager.mutex.Unlock()
	connManager.publicIP = ip
	if ip != "" {
		log.Printf("WebSocket handler configured with public IP: %s", ip)
	}
}

// SetUDPPortRange 设置UDP端口范围
func SetUDPPortRange(min, max uint16) {
	connManager.mutex.Lock()
	defer connManager.mutex.Unlock()
	connManager.udpPortMin = min
	connManager.udpPortMax = max
	if min > 0 && max > 0 {
		log.Printf("WebSocket handler configured with UDP port range: %d-%d", min, max)
	}
}

// WebSocketHandler 处理 WebSocket 连接
func WebSocketHandler(ws *websocket.Conn) {
	defer ws.Close()
	ws.MaxPayloadBytes = maxSignalBytes
	ws.SetReadDeadline(time.Time{})
	ws.SetWriteDeadline(time.Now().Add(writeTimeout))
	stopHeartbeat := keepAlive(ws, pingInterval)
	defer stopHeartbeat()
	var closeOnce sync.Once
	fail := func(code int) {
		closeOnce.Do(func() {
			ws.SetWriteDeadline(time.Now().Add(writeTimeout))
			ws.WriteClose(code)
			ws.Close()
		})
	}

	// 验证Origin
	if !validateOrigin(ws.Request()) {
		log.Printf("Invalid origin from %s", ws.Request().RemoteAddr)
		fail(closePolicyViolation)
		return
	}

	// 为每个连接创建独立的PeerConnection
	publicIP, udpPortMin, udpPortMax := connManager.config()

	// 使用完整配置初始化PeerConnection
	peerConnection, err := datachannel.NewPeerConnection(datachannel.Config{
		PublicIP:   publicIP,
		UDPPortMin: udpPortMin,
		UDPPortMax: udpPortMax,
	})

	if err != nil {
		log.Printf("Failed to initialize peer connection: %v", err)
		fail(closeInternalError)
		return
	}

	// 生成连接ID
	connID := generateConnectionID()

	// 注册连接
	connManager.registerConnection(connID, peerConnection)
	defer connManager.unregisterConnection(connID)
	peerConnection.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		switch state {
		case webrtc.PeerConnectionStateClosed:
			go fail(1000)
		case webrtc.PeerConnectionStateFailed:
			go fail(closeInternalError)
		}
	})

	datachannel.HandleICECandidate(peerConnection, ws)

	var channelCount atomic.Uint32
	var echoFailed atomic.Bool
	peerConnection.OnDataChannel(func(d *webrtc.DataChannel) {
		// Bound the lifetime count too, so channel churn cannot exhaust resources.
		if channelCount.Add(1) > maxDataChannels {
			if echoFailed.Swap(true) {
				return
			}
			log.Printf("Too many data channels for connection %s", connID)
			go fail(closePolicyViolation)
			return
		}
		d.OnOpen(func() {
			log.Println("Data channel opened for connection:", connID)
		})
		d.OnMessage(func(msg webrtc.DataChannelMessage) {
			if echoFailed.Load() {
				return // The session is already being closed with an explicit error.
			}
			if err := datachannel.Echo(d, msg); err != nil {
				echoFailed.Store(true)
				log.Printf("Failed to send message for connection %s: %v", connID, err)
				code := closeInternalError
				if errors.Is(err, datachannel.ErrEchoOverloaded) {
					code = closeOverloaded
				}
				// Closing the peer synchronously from its callback can deadlock.
				go fail(code)
			}
		})
	})

	// 消息处理循环 - 支持长时间连接
	for {
		var msg string
		if err := websocket.Message.Receive(ws, &msg); err != nil {
			log.Printf("Can't receive from %s: %v", connID, err)
			if errors.Is(err, websocket.ErrFrameTooLarge) {
				fail(closeMessageTooBig)
			}
			return
		}

		if err := datachannel.HandleSignal(peerConnection, msg, ws); err != nil {
			log.Printf("Failed to handle signal for %s: %v", connID, err)
			fail(closePolicyViolation)
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
	return time.Now().Format("20060102150405") + "-" + rand.Text()
}

func (cm *ConnectionManager) config() (string, uint16, uint16) {
	cm.mutex.RLock()
	defer cm.mutex.RUnlock()
	return cm.publicIP, cm.udpPortMin, cm.udpPortMax
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
	pc := cm.connections[id]
	delete(cm.connections, id)
	cm.mutex.Unlock()
	if pc != nil {
		pc.Close()
	}
}

// GetConnection 获取连接
func (cm *ConnectionManager) GetConnection(id string) (*webrtc.PeerConnection, bool) {
	cm.mutex.RLock()
	defer cm.mutex.RUnlock()
	pc, exists := cm.connections[id]
	return pc, exists
}
