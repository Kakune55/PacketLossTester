# 网络丢包率测试

这是一个简单的网络丢包率测试工具，使用WebRTC技术在浏览器中模拟发送和接收UDP数据包，以评估网络连接的稳定性和丢包率。

## 功能特点

- **动态调整参数：** 用户可以调整每秒发送的数据包数量、数据包大小和测试持续时间。
- **实时统计：** 在测试过程中实时显示发送的数据包数量、接收的数据包数量和计算的丢包率。
- **图表显示：** 使用Chart.js库绘制柱状图，展示每个数据包的延迟情况，便于用户分析网络稳定性和波动。
- **用户友好界面：** 使用HTML、CSS和JavaScript构建，界面简洁清晰，易于使用和理解。
- **网络测速页面：** 独立的带宽测试页面，可测量下载、上传速度与往返延迟。

## 技术栈

- **前端：** HTML, CSS, JavaScript (WebRTC, WebSocket, Chart.js)
- **后端：** Go语言

## 使用方法

1. **安装和运行后端：**
   - 使用Go语言编译和运行后端代码，确保WebSocket服务器和相关服务可用。
   
2. **启动前端：**
   - 在支持WebRTC的现代浏览器（如Chrome、Firefox等）中打开URL，即可进入测试页面。
   - 调整滑动条来设置每秒发送的数据包数量、数据包大小和测试持续时间。
   
3. **开始测试：**
   - 点击"开始测试"按钮后，系统会建立WebSocket连接和WebRTC数据通道，开始发送和接收数据包。
   - 实时显示发送的数据包数量、接收的数据包数量和计算的丢包率。
   - 测试结束后，系统会显示详细的延迟情况图表，并汇报测试结果。

4. **网络测速：**
  - 在首页右上角点击“网络测速”跳转至带宽测试页面。
  - 页面会自动测量下载（约 10 MB）、上传（约 5 MB）带宽和往返延迟，并实时显示结果。
  - 建议多次测试取平均值，或在空闲网络环境下进行以获得更精确的数据。

### Docker 部署

```bash
docker run -d --network host -v /etc/packLossTester:/app/etc --name pltester kakune55/packlosstester
```

配置文件自动挂载，默认配置文件为`/etc/packLossTester/config.json`
修改后重启docker容器生效

## 云服务器配置指南

### 问题说明

在云服务器环境下(同时拥有公网IP和内网IP),建立WebRTC数据通道可能会卡住,原因是:

1. **NAT映射问题**: WebRTC无法自动识别云服务器的公网IP
2. **防火墙端口**: 随机高位UDP端口可能被防火墙拦截

### 解决方案

#### 1. 配置文件设置 (`etc/config.json`)

```json
{
  "listen_port": 52611,
  "public_ip": "8.155.54.103",
  "udp_port_min": 50000,
  "udp_port_max": 50100
}
```

**参数说明:**

- `listen_port`: WebSocket服务监听端口
- `public_ip`: **必填** - 云服务器的公网IP地址
- `udp_port_min`: UDP端口范围最小值 (建议: 50000)
- `udp_port_max`: UDP端口范围最大值 (建议: 50100)

#### 2. 防火墙配置

##### 阿里云 ECS

```bash
# 开放WebSocket端口
sudo firewall-cmd --permanent --add-port=52611/tcp

# 开放UDP端口范围
sudo firewall-cmd --permanent --add-port=50000-50100/udp

# 重载防火墙
sudo firewall-cmd --reload
```

**或者在阿里云控制台 → 安全组规则中添加:**

| 协议 | 端口范围 | 授权对象 | 说明 |
|------|----------|----------|------|
| TCP | 52611 | 0.0.0.0/0 | WebSocket服务 |
| UDP | 50000-50100 | 0.0.0.0/0 | WebRTC数据通道 |

##### 腾讯云 CVM

```bash
# 开放WebSocket端口
sudo ufw allow 52611/tcp

# 开放UDP端口范围
sudo ufw allow 50000:50100/udp

# 重载防火墙
sudo ufw reload
```

**或者在腾讯云控制台 → 安全组 → 入站规则中添加**

##### AWS EC2

在 **Security Groups** 中添加入站规则:

- TCP: 52611
- UDP: 50000-50100

#### 3. 环境变量方式 (可选)

如果不想修改配置文件,也可以使用环境变量:

```bash
export PUBLIC_IP=8.155.54.103
./package_loss_tester
```

#### 4. 验证配置

启动程序后,查看日志输出:

```
2025/10/30 12:34:56 Public IP configured: 8.155.54.103
2025/10/30 12:34:56 UDP port range configured: 50000-50100
2025/10/30 12:34:56 Using public IP for NAT 1:1 mapping: 8.155.54.103
2025/10/30 12:34:56 Setting UDP port range: 50000-50100
```

在WebSocket数据中应该看到公网IP的候选:

```json
{
  "candidate": "candidate:3535376112 1 udp 2130706431 8.155.54.103 50001 typ host",
  "sdpMid": "",
  "sdpMLineIndex": 0
}
```

#### 5. 故障排查

##### 问题: 仍然使用随机高位端口

**可能原因:**
- 配置文件未正确加载
- 端口范围配置错误 (min > max)

**解决:**
```bash
# 检查配置文件
cat etc/config.json

# 确保 udp_port_min < udp_port_max
```

##### 问题: 连接仍然超时

**可能原因:**
- 防火墙未正确配置
- 公网IP填写错误

**解决:**
```bash
# 测试UDP端口是否开放
nc -vuz 8.155.54.103 50000

# 验证公网IP
curl ifconfig.me
```

##### 问题: ICE候选只有内网IP

**可能原因:**
- `public_ip` 配置为空或错误

**解决:**
```bash
# 获取公网IP
curl ifconfig.me

# 更新配置文件
echo '{"listen_port":52611,"public_ip":"YOUR_PUBLIC_IP","udp_port_min":50000,"udp_port_max":50100}' > etc/config.json
```

### 推荐配置

#### 生产环境

```json
{
  "listen_port": 52611,
  "public_ip": "YOUR_PUBLIC_IP",
  "udp_port_min": 50000,
  "udp_port_max": 50100
}
```

- 端口范围: 100个端口足够支持并发连接
- 更大范围会消耗更多防火墙资源

#### 测试环境

```json
{
  "listen_port": 52611,
  "public_ip": "YOUR_PUBLIC_IP",
  "udp_port_min": 0,
  "udp_port_max": 0
}
```

- 端口范围设为0表示使用随机端口
- 需要开放所有UDP端口 (1024-65535)

### 如何获取公网IP

```bash
# Linux
curl ifconfig.me

# 或者
curl icanhazip.com
```

配置公网IP后，WebRTC 将使用 NAT 1:1 映射，确保客户端能够正确连接到您的服务器。

## 注意事项

- **性能问题：** 当测试数据量较大时，可能会影响浏览器性能，请根据需要调整测试参数。
- **浏览器支持：** 推荐使用最新版本的Chrome或Firefox浏览器以获得最佳体验。
- **网络环境：** 测试结果可能受到网络环境和设备性能的影响，不同网络条件下的结果可能有所不同。

## 贡献者

- 如果你有任何建议或发现了Bug，请提交Issue或Pull Request，我们欢迎你的贡献。

## 授权许可

本项目使用 [MIT许可证](LICENSE) 进行授权。

## 参考资料

- [WebRTC NAT Traversal](https://webrtc.org/getting-started/firewall)
- [Pion WebRTC SettingEngine](https://pkg.go.dev/github.com/pion/webrtc/v3#SettingEngine)