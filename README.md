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

### IP 属地服务配置

在 `etc/config.json` 中可设置 `ip_api_custom_host`，修改后重启生效：

```json
{
  "listen_port": 52611,
  "ip_api_custom_host": "https://ip.example.com/proxy/json/?key=YOUR_API_KEY"
}
```

- 留空或省略时使用 `http://ip-api.com/json/`。自定义地址必须指向 **ip-api 兼容的 JSON API**，不是任意 IP 查询服务；程序不会自动添加 `/json`。
- 推荐显式使用 `https://`。也接受 `http://`；无 scheme 的 `example.com/json`、`localhost:8080/json` 按 HTTPS 处理。IPv6 主机必须加方括号，例如 `http://[::1]:8080/json/`。
- 启动时检查 scheme、host、端口及 URL 编码，不联网探测服务。不支持非 HTTP(S) scheme、相对路径或 fragment（`#...`）。
- 基础路径及查询认证参数会保留，路径末尾有无 `/` 均可。查询指定 IP 时追加一个路径段（支持 IPv4/IPv6）；自动查询服务器出口 IP 时请求基础路径加尾斜杠。
- 程序设置 `fields=status,message,country,countryCode,region,regionName,city,lat,lon,isp,org,as,asname,query,timezone` 和 `lang=zh-CN`，覆盖同名配置参数；其他查询参数（包括重复的认证参数）保留其值，查询参数顺序和编码形式可能规范化。
- 服务应返回 HTTP 200 和 ip-api 格式 JSON：成功时 `status` 为 `success`，`query` 为 IP，地理和运营商信息使用 `country`、`regionName`、`city`、`lat`、`lon`、`isp`、`org`、`as`、`asname`、`timezone`；失败时返回 `status: "fail"` 和 `message`。不兼容或缺失 `status` 的响应不视为成功。
- 返回给前端的成功结果中，`source` 为所配置服务的主机名（默认 `ip-api.com`），不包含端口、路径、用户名或认证查询参数。它标识查询服务，不验证服务返回数据的真实来源。

### 多节点配置

主站通过 `GET /api/nodes` 提供节点目录，浏览器直接连接所选节点，主站不转发测试流量。在主站的 `etc/config.json` 中添加 `nodes`，修改后重启即可生效，无需重新编译：

```json
{
  "listen_port": 52611,
  "nodes": [
    {
      "id": "local",
      "name": "本机节点",
      "baseUrl": ""
    },
    {
      "id": "hk-01",
      "name": "香港一号",
      "region": "香港",
      "baseUrl": "https://hk.example.com",
      "capabilities": ["packetloss", "speedtest"]
    }
  ]
}
```

- `nodes` 省略或为空时默认使用本机节点。旧的 `static/nodes.json` 已移除，自定义节点请迁移到此配置。
- `id` 是唯一且稳定的标识，只允许英文字母、数字、`-` 和 `_`；`name` 必填，`region` 可选。
- `baseUrl` 留空表示当前站点；外部节点必须是完整 HTTP(S) 地址，可以包含路径前缀，例如 `https://hk.example.com/test`。不允许认证信息、查询参数或 fragment。HTTPS 主站不能选择 HTTP 节点。
- `capabilities` 省略时同时支持两类测试，也可只声明 `packetloss` 或 `speedtest`。它控制目录展示，不会关闭节点上的实际接口。
- 节点需提供约定的 `/ws`、`/speedtest/ping`、`/speedtest/download`、`/speedtest/upload` 路径；有前缀时追加在前缀下，由反向代理转发。HTTP 探测接口应返回 `{"ok":true}`，只提供丢包测试的节点也需要此探测接口。
- 两个测试页面共享节点选择，浏览器会记忆节点 ID；可使用 `/?node=hk-01` 或 `/speedtest.html?node=hk-01` 分享指定节点。URL 参数只接受目录内的 ID，不接受自定义服务地址。
- “检测可达性”由浏览器按最多 3 个节点并发，每节点进行 3 次 HTTP 探测（每次最多 2 秒），全部成功时展示中位数；失败显示不可达，不自动切换节点。这不是 WebRTC RTT 或带宽预估。开始测试会停止探测，并锁定本轮节点直到结算结束。

每个远端节点仍独立部署本程序，设置自己的公网 IP、UDP 端口和 HTTPS/WSS。为允许主站跨域访问，可在远端节点配置精确的主站 Origin：

```json
{
  "listen_port": 52611,
  "allowed_origins": ["https://test.example.com", "https://hk.example.com"]
}
```

名单同时用于 HTTP CORS 和 WebSocket 升级前检查。Origin 不包含路径或末尾斜杠；若节点也提供独立页面，应加入它自己的 Origin。省略 `allowed_origins` 默认保持公开节点行为（`["*"]`）；显式 `[]` 拒绝所有带 Origin 的请求。无 Origin 的普通 HTTP 请求仍允许，Origin 白名单不是身份认证，也不能阻止伪造请求的非浏览器客户端。

测速路由应绕过 CDN 缓存，关闭压缩和内容转换；WebSocket 需要支持升级，WebRTC 的 UDP 端口应直达节点。不要将测试流量绕经主站代理，否则结果会混入中转链路影响。

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

| 协议 | 端口范围 | 授权对象 | 说明 |
|------|----------|----------|------|
| TCP | 52611 | 0.0.0.0/0 | WebSocket服务 |
| UDP | 50000-50100 | 0.0.0.0/0 | WebRTC数据通道 |

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
- [Pion WebRTC SettingEngine](https://pkg.go.dev/github.com/pion/webrtc/v4#SettingEngine)
