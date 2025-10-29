let sentPackets = 0;
let receivedPackets = 0;
let dataChannel;
let pc;
let intervalId;
let chartUpdateIntervalId; // 图表更新定时器ID
let durationTimeoutId; // 持续时间定时器ID
let chart;
const sentPacketTimes = {};
let packetCount = 0;
let isStressMode = false; // 压测模式标志
let stressStartTime = 0; // 压测模式开始时间

const frequency_input = document.getElementById('frequency');
const size_input = document.getElementById('size');
const duration_input = document.getElementById('duration');

// 获取测试节点列表
const apiUrl = 'nodes.json';

// 使用fetch获取数据
fetch(apiUrl)
    .then(response => {
        // 确保响应的状态是OK的
        if (!response.ok) {
            throw new Error(`获取节点失败: ${response.status}`);
        }
        // 解析JSON格式的响应数据
        return response.json();
    })
    .then(data => {
        // 获取<select>元素
        const selectElement = document.getElementById('testNode');
        // 清空现有的<option>元素
        selectElement.innerHTML = '';

        // 遍历数据，创建新的<option>元素并添加到<select>中
        data.forEach(item => {
            const option = document.createElement('option');
            option.value = item.url;
            option.textContent = item.name;
            selectElement.appendChild(option);
        });
    })
    .catch(error => {
        // 处理错误
        console.error('错误:', error);
    });


const updateValue = (id) => {
    document.getElementById(`${id}-value`).innerText = document.getElementById(id).value;
};

// 切换压测模式
const toggleStressMode = () => {
    isStressMode = document.getElementById('stress-mode').checked;
    const durationGroup = document.getElementById('duration').parentElement;
    
    if (isStressMode) {
        // 禁用持续时间设置
        durationGroup.style.opacity = '0.5';
        document.getElementById('duration').disabled = true;
    } else {
        // 启用持续时间设置
        durationGroup.style.opacity = '1';
        document.getElementById('duration').disabled = false;
    }
};

const maxsize = 10240;

frequency_input.addEventListener("change", (event) => {
    if (parseInt(frequency_input.value) > 64) {
        duration_input.max = 30;
        size_input.max = 4096;
        if (parseInt(duration_input.value) == 30) {
            document.getElementById(`duration-value`).innerText = 30;
        }
        if (parseInt(size_input.value) == 4096) {
            document.getElementById(`size-value`).innerText = 4096;
        }
    } else {
        duration_input.max = 180;
        size_input.max = maxsize;
    }
})

const setStatus = (status) => {
    document.getElementById('status').innerText = `状态: ${status}`;
};

const startSendingData = (frequency, size, totalPackets, duration) => {
    packetCount = 0;
    if (isStressMode) {
        stressStartTime = Date.now();
    }
    
    // 启动图表更新定时器，每1秒更新一次
    if (chartUpdateIntervalId) {
        clearInterval(chartUpdateIntervalId);
    }
    chartUpdateIntervalId = setInterval(() => {
        updateChart();
    }, 500);
    
    intervalId = setInterval(() => {
        // 压测模式下不检查 totalPackets
        if (!isStressMode && (packetCount >= totalPackets || dataChannel.readyState !== 'open')) {
            stopTest();
            return;
        }
        
        if (dataChannel.readyState !== 'open') {
            stopTest();
            return;
        }
        
        const packet = `${packetCount},${Date.now()}`;
        dataChannel.send(packet);
        sentPacketTimes[packetCount] = { sentTime: Date.now(), received: false };
        packetCount++;
        
        // 压测模式下，清理10秒前的数据
        if (isStressMode) {
            const currentTime = Date.now();
            const cutoffTime = currentTime - 10000; // 10秒前
            for (let key in sentPacketTimes) {
                if (sentPacketTimes[key].sentTime < cutoffTime) {
                    // 删除过期的数据包记录
                    delete sentPacketTimes[key];
                }
            }
            // 更新显示的发送包数量为当前窗口内的包数量
            document.getElementById('sent-packets').innerText = Object.keys(sentPacketTimes).length;
        } else {
            document.getElementById('sent-packets').innerText = packetCount;
        }
    }, 1000 / frequency);

    // 非压测模式下设置持续时间定时器
    if (!isStressMode) {
        durationTimeoutId = setTimeout(() => {
            stopTest();
        }, duration * 1000);
    }
};

// 停止测试函数
const stopTest = () => {
    if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
    }
    if (chartUpdateIntervalId) {
        clearInterval(chartUpdateIntervalId);
        chartUpdateIntervalId = null;
    }
    if (durationTimeoutId) {
        clearTimeout(durationTimeoutId);
        durationTimeoutId = null;
    }
    
    setStatus('测试完成');
    document.getElementById('start-btn').disabled = false;
    document.getElementById('stop-btn').style.display = 'none';
    
    // 在测试结束后，检查并更新图表中未收到的数据包
    if (!isStressMode) {
        for (let i = 0; i < packetCount; i++) {
            if (sentPacketTimes[i] && !sentPacketTimes[i].received) {
                sentPacketTimes[i].latency = -1; // 使用-1表示丢失的数据包
            }
        }
    }
    updateChart(); // 最后一次更新图表
};

const handleWebSocketMessage = async (event) => {
    const message = JSON.parse(event.data);
    if (message.candidate) {
        try {
            await pc.addIceCandidate(new RTCIceCandidate(message));
        } catch (e) {
            console.error("添加接收到的ICE候选者时出错", e);
        }
    } else if (message.sdp) {
        await pc.setRemoteDescription(new RTCSessionDescription(message));
        if (message.type === 'offer') {
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            ws.send(JSON.stringify(pc.localDescription));
        }
    }
};

document.getElementById('start-btn').addEventListener('click', async () => {
    document.getElementById('start-btn').disabled = true;
    document.getElementById('stop-btn').style.display = 'inline-block'; // 显示停止按钮
    setStatus('建立连接中...');

    const frequency = parseInt(document.getElementById('frequency').value);
    const size = parseInt(document.getElementById('size').value);
    const duration = parseInt(document.getElementById('duration').value);
    const totalPackets = isStressMode ? Infinity : frequency * duration; // 压测模式下无限制

    sentPackets = 0;
    receivedPackets = 0;
    document.getElementById('sent-packets').innerText = sentPackets;
    document.getElementById('received-packets').innerText = receivedPackets;
    document.getElementById('packet-loss-rate').innerText = '0%';


    const ws = new WebSocket(document.getElementById('testNode').value);
    ws.onopen = async () => {
        console.log("WebSocket连接已打开");
        setStatus('连接已建立，准备建立数据通道测试...');

        const configuration = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
            ]
        };
        pc = new RTCPeerConnection(configuration);
        dataChannel = pc.createDataChannel('dataChannel', { ordered: false, maxRetransmits: 0 });

        dataChannel.onopen = () => {
            console.log("数据通道已打开");
            setStatus('测试中...');
            startSendingData(frequency, size, totalPackets, duration);
        };

        let updateUIPending = false;

        function updateUI() {
            if (!updateUIPending) {
                requestAnimationFrame(() => {
                    let totalSent, receivedCount, lossRate;
                    
                    // 压测模式下，只计算当前窗口内的包
                    if (isStressMode) {
                        totalSent = Object.keys(sentPacketTimes).length;
                        // 重新计算接收到的包数量
                        receivedCount = 0;
                        for (let key in sentPacketTimes) {
                            if (sentPacketTimes[key].received) {
                                receivedCount++;
                            }
                        }
                        lossRate = totalSent > 0 ? ((totalSent - receivedCount) / totalSent) * 100 : 0;
                    } else {
                        // 正常模式
                        totalSent = packetCount;
                        receivedCount = receivedPackets;
                        lossRate = totalSent > 0 ? ((totalSent - receivedCount) / totalSent) * 100 : 0;
                    }
                    
                    // 更新显示
                    document.getElementById('received-packets').innerText = receivedCount;
                    document.getElementById('packet-loss-rate').innerText = lossRate.toFixed(2) + '%';
                    updateUIPending = false;
                });
            }
            updateUIPending = true;
        }

        dataChannel.onmessage = (event) => {
            const [packetIndex, sentTime] = event.data.split(',');
            const currentTime = Date.now();
            const latency = currentTime - parseInt(sentTime, 10);
            
            // 只有在记录中存在该包时才处理
            if (sentPacketTimes[packetIndex]) {
                // 非压测模式下才累加 receivedPackets
                if (!isStressMode && !sentPacketTimes[packetIndex].received) {
                    receivedPackets++;
                }
                sentPacketTimes[packetIndex].received = true;
                sentPacketTimes[packetIndex].latency = latency;

                // 异步更新UI，避免阻塞数据处理流程
                updateUI();
            }
        };

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                ws.send(JSON.stringify(event.candidate.toJSON()));
            }
        };

        ws.onmessage = handleWebSocketMessage;

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        ws.send(JSON.stringify(pc.localDescription));

        // 初始化图表
        const ctx = document.getElementById('chart').getContext('2d');
        chart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: [],
                datasets: [
                    {
                        type: 'bar',
                        label: '最大延迟 (ms)',
                        borderColor: 'rgb(255, 99, 132)',
                        backgroundColor: 'rgba(255, 99, 132, 0.6)',
                        data: [],
                        order: 2, // 较大的order值会显示在底层
                    },
                    {
                        type: 'bar',
                        label: '平均延迟 (ms)',
                        borderColor: 'rgb(54, 162, 235)',
                        backgroundColor: 'rgba(54, 162, 235, 0.7)',
                        data: [],
                        order: 1, // 较小的order值会显示在顶层
                    }
                ],
            },
            options: {
                responsive: true,
                animation: {
                    duration: 750, // 动画持续时间（毫秒）
                    easing: 'easeInOutQuart', // 缓动函数
                },
                transitions: {
                    active: {
                        animation: {
                            duration: 400 // 活动状态下的动画时间
                        }
                    }
                },
                plugins: {
                    tooltip: {
                        callbacks: {
                            label: (context) => {
                                const value = context.raw;
                                return value === -1 ? '丢失数据包' : `延迟: ${value} ms`;
                            }
                        }
                    }
                }
            }
        });
    };

    ws.onerror = () => {
        setStatus('连接失败');
        document.getElementById('start-btn').disabled = false;
    };

    ws.onclose = () => {
        stopTest();
        setStatus('连接关闭');
    };
});

// 停止按钮事件监听器
document.getElementById('stop-btn').addEventListener('click', () => {
    stopTest();
    if (pc) {
        pc.close();
    }
});

const updateChart = () => {
    const labels = [];
    const dataAvg = [];
    const dataMax = [];
    const dataMin = [];

    let dataToProcess;
    
    if (isStressMode) {
        // 压测模式：只处理最近10秒的数据（滚动窗口）
        const currentTime = Date.now();
        const cutoffTime = currentTime - 10000; // 10秒前
        
        // 获取所有有效的包索引并排序
        const validKeys = Object.keys(sentPacketTimes)
            .map(k => parseInt(k))
            .filter(k => sentPacketTimes[k].sentTime >= cutoffTime)
            .sort((a, b) => a - b);
        
        if (validKeys.length === 0) return;
        
        const minKey = validKeys[0];
        const maxKey = validKeys[validKeys.length - 1];
        const range = maxKey - minKey + 1;
        const sampleSize = Math.max(1, Math.ceil(range / 120)); // 固定分成120组
        
        for (let i = minKey; i <= maxKey; i += sampleSize) {
            const endIndex = Math.min(i + sampleSize, maxKey + 1);
            let sumLatency = 0;
            let validCount = 0;
            let maxLatency = -Infinity;
            let minLatency = Infinity;

            for (let j = i; j < endIndex; j++) {
                if (sentPacketTimes[j]) {
                    const latency = sentPacketTimes[j].latency;
                    if (latency !== undefined && latency !== -1) {
                        sumLatency += latency;
                        validCount++;
                        if (latency > maxLatency) maxLatency = latency;
                        if (latency < minLatency) minLatency = latency;
                    }
                }
            }

            if (validCount > 0) {
                const averageLatency = sumLatency / validCount;
                // 使用相对时间（秒）作为标签
                const relativeTime = ((i - minKey) * 1000 / (frequency_input.value || 32) / 1000).toFixed(1);
                labels.push(relativeTime + 's');
                dataAvg.push(averageLatency);
                dataMax.push(maxLatency);
                dataMin.push(minLatency);
            }
        }
    } else {
        // 正常模式：处理所有数据
        const sampleSize = Math.ceil(packetCount / 120); // 固定分成120组

        for (let i = 0; i < packetCount - 2; i += sampleSize) {
            const endIndex = Math.min(i + sampleSize, packetCount);
            let sumLatency = 0;
            let validCount = 0;
            let maxLatency = -Infinity;
            let minLatency = Infinity;

            for (let j = i; j < endIndex; j++) {
                if (sentPacketTimes[j]) {
                    const latency = sentPacketTimes[j].latency;
                    if (latency !== undefined && latency !== -1) {
                        sumLatency += latency;
                        validCount++;
                        if (latency > maxLatency) maxLatency = latency;
                        if (latency < minLatency) minLatency = latency;
                    }
                }
            }

            if (validCount > 0) {
                const averageLatency = sumLatency / validCount;
                labels.push(i);
                dataAvg.push(averageLatency);
                dataMax.push(maxLatency);
                dataMin.push(minLatency);
            }
        }
    }

    // 动态更新数据，而不是重新创建 datasets
    // 这样可以产生平滑的过渡动画
    chart.data.labels = labels;
    
    // 更新最大延迟数据 (datasets[0] - 红色柱状图，底层)
    if (chart.data.datasets[0]) {
        chart.data.datasets[0].data = dataMax;
    }
    
    // 更新平均延迟数据 (datasets[1] - 蓝色柱状图，顶层)
    if (chart.data.datasets[1]) {
        chart.data.datasets[1].data = dataAvg;
    }
    
    // 使用 'active' 模式进行平滑动画更新
    chart.update('active');
};