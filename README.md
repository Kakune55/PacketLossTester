# 网络丢包率测试

这是一个简单的网络丢包率测试工具，使用WebRTC技术在浏览器中模拟发送和接收UDP数据包，以评估网络连接的稳定性和丢包率。

## 功能特点

- **动态调整参数：** 用户可以调整每秒发送的数据包数量、数据包大小和测试持续时间。
- **实时统计：** 在测试过程中实时显示发送的数据包数量、接收的数据包数量和计算的丢包率。
- **图表显示：** 使用Chart.js库绘制柱状图，展示每个数据包的延迟情况，便于用户分析网络稳定性和波动。
- **用户友好界面：** 使用HTML、CSS和JavaScript构建，界面简洁清晰，易于使用和理解。

## 技术栈

- **前端：** HTML, CSS, JavaScript (WebRTC, WebSocket, Chart.js)
- **后端：** Go语言

## 使用方法

1. **安装和运行后端：**
   - 使用Go语言编译和运行后端代码，确保WebSocket服务器和相关服务可用。
   
2. **启动前端：**
   - 在支持WebRTC的现代浏览器（如Chrome、Firefox等）中打开`index.html`文件。
   - 调整滑动条来设置每秒发送的数据包数量、数据包大小和测试持续时间。
   
3. **开始测试：**
   - 点击“开始测试”按钮后，系统会建立WebSocket连接和WebRTC数据通道，开始发送和接收数据包。
   - 实时显示发送的数据包数量、接收的数据包数量和计算的丢包率。
   - 测试结束后，系统会显示详细的延迟情况图表，并汇报测试结果。

## 注意事项

- **性能问题：** 当测试数据量较大时，可能会影响浏览器性能，请根据需要调整测试参数。
- **浏览器支持：** 推荐使用最新版本的Chrome或Firefox浏览器以获得最佳体验。
- **网络环境：** 测试结果可能受到网络环境和设备性能的影响，不同网络条件下的结果可能有所不同。

## 贡献者

- 如果你有任何建议或发现了Bug，请提交Issue或Pull Request，我们欢迎你的贡献。

## 授权许可

本项目使用 [MIT许可证](LICENSE) 进行授权。