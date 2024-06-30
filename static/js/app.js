let sentPackets = 0;
let receivedPackets = 0;
let dataChannel;
let pc;
let intervalId;
let chart;
const sentPacketTimes = {};
let packetCount = 0;

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
    intervalId = setInterval(() => {
        if (packetCount >= totalPackets || dataChannel.readyState !== 'open') {
            clearInterval(intervalId);
            setStatus('测试完成');
            document.getElementById('start-btn').disabled = false;
            updateChart(); // 最后一次更新图表
            return;
        }
        const packet = `${packetCount},${Date.now()}`;
        dataChannel.send(packet);
        sentPacketTimes[packetCount] = { sentTime: Date.now(), received: false };
        packetCount++;
        document.getElementById('sent-packets').innerText = packetCount;
    }, 1000 / frequency);

    setTimeout(() => {
        clearInterval(intervalId);
        setStatus('测试完成');
        document.getElementById('start-btn').disabled = false;
        // 在测试结束后，检查并更新图表中未收到的数据包
        for (let i = 0; i < packetCount; i++) {
            if (!sentPacketTimes[i].received) {
                sentPacketTimes[i].latency = -1; // 使用-1表示丢失的数据包
            }
        }
        updateChart(); // 最后一次更新图表
    }, duration * 1000);
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
    setStatus('建立连接中...');

    const frequency = parseInt(document.getElementById('frequency').value);
    const size = parseInt(document.getElementById('size').value);
    const duration = parseInt(document.getElementById('duration').value);
    const totalPackets = frequency * duration;

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
                    // 更新接收到的数据包数量
                    document.getElementById('received-packets').innerText = receivedPackets;
                    // 计算并更新丢包率
                    const lossRate = ((packetCount - receivedPackets) / packetCount) * 100;
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
            receivedPackets++;
            sentPacketTimes[packetIndex].received = true;
            sentPacketTimes[packetIndex].latency = latency;

            // 异步更新UI，避免阻塞数据处理流程
            updateUI();
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
                        label: '延迟 (ms)',
                        borderColor: 'rgb(75, 192, 192)',
                        backgroundColor: (context) => {
                            const index = context.dataIndex;
                            const value = context.dataset.data[index];
                            return value === -1 ? 'rgb(255, 99, 132)' : 'rgb(75, 192, 192)';
                        },
                        fill: false,
                        data: [],
                    }
                ],
            },
            options: {
                responsive: true,
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
        if (intervalId) {
            clearInterval(intervalId);
        }
        setStatus('连接关闭');
        document.getElementById('start-btn').disabled = false;
    };
});

const updateChart = () => {
    const labels = [];
    const dataAvg = [];
    const dataMax = [];
    const dataMin = [];

    const sampleSize = Math.ceil(packetCount / 120); // 固定分成120组

    for (let i = 0; i < packetCount - 2; i += sampleSize) {
        const endIndex = Math.min(i + sampleSize, packetCount);
        let sumLatency = 0;
        let validCount = 0;
        let maxLatency = -Infinity;
        let minLatency = Infinity;

        for (let j = i; j < endIndex; j++) {
            const latency = sentPacketTimes[j].latency;
            if (latency !== undefined && latency !== -1) {
                sumLatency += latency;
                validCount++;
                if (latency > maxLatency) maxLatency = latency;
                if (latency < minLatency) minLatency = latency;
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

    chart.data.labels = labels;
    chart.data.datasets = [
        {
            label: '平均延迟 (ms)',
            borderColor: 'rgb(75, 192, 192)',
            backgroundColor: 'rgba(75, 192, 192',
            fill: false,
            data: dataAvg,
        },
        {
            type: 'line',
            label: '最大延迟 (ms)',
            borderColor: 'rgb(255, 0, 0, 0.4)',
            backgroundColor: 'rgba(255, 0, 0, 0.4)',
            fill: false,
            data: dataMax,
        },
        // {
        //     label: '最小延迟 (ms)',
        //     borderColor: 'rgb(54, 162, 235)',
        //     backgroundColor: 'rgba(54, 162, 235)',
        //     fill: false,
        //     data: dataMin,
        // },
    ];
    chart.update();
};