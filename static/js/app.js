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

let latencyStats = {
    min: Infinity,
    max: -Infinity,
    sum: 0,
    count: 0,
    values: [],        // 存储所有延迟值用于计算百分位
    lastLatency: null, // 上一个延迟值，用于计算抖动
    jitterSum: 0,      // 抖动累计值
    jitterCount: 0     // 抖动样本数
};

// 重置统计数据
function resetLatencyStats() {
    latencyStats = {
        min: Infinity,
        max: -Infinity,
        sum: 0,
        count: 0,
        values: [],
        lastLatency: null,
        jitterSum: 0,
        jitterCount: 0
    };
    
    // 重置显示
    document.getElementById('avg-latency').innerText = '-';
    document.getElementById('min-latency').innerText = '-';
    document.getElementById('max-latency').innerText = '-';
    document.getElementById('p90-latency').innerText = '-';
    document.getElementById('jitter').innerText = '-';
}

// 更新延迟统计
let statsUpdatePending = false;
function updateLatencyStats(latency) {
    latencyStats.sum += latency;
    latencyStats.count++;
    latencyStats.values.push(latency);
    
    // 计算抖动(Jitter)：当前延迟与上一个延迟的差值的绝对值
    // 这是网络抖动的标准定义：连续数据包延迟的变化量
    if (latencyStats.lastLatency !== null) {
        const jitter = Math.abs(latency - latencyStats.lastLatency);
        latencyStats.jitterSum += jitter;
        latencyStats.jitterCount++;
    }
    latencyStats.lastLatency = latency;
    
    // 只保留最近2000个样本用于计算百分位（避免内存占用过大）
    if (latencyStats.values.length > 2000) {
        latencyStats.values.shift();
    }
    
    if (latency < latencyStats.min) latencyStats.min = latency;
    if (latency > latencyStats.max) latencyStats.max = latency;
    
    if (!statsUpdatePending) {
        statsUpdatePending = true;
        requestAnimationFrame(() => {
            // 计算平均延迟
            const avg = latencyStats.sum / latencyStats.count;
            
            // 计算平均抖动
            const avgJitter = latencyStats.jitterCount > 0 
                ? latencyStats.jitterSum / latencyStats.jitterCount 
                : 0;
            
            // 计算90百分位（前10%最高延迟的起始值）
            let p90 = 0;
            if (latencyStats.values.length > 0) {
                const sorted = [...latencyStats.values].sort((a, b) => a - b);
                const p90Index = Math.floor(sorted.length * 0.9);
                p90 = sorted[p90Index];
            }
            
            // 批量更新UI（高精度显示，保留3位小数）
            document.getElementById('avg-latency').innerText = avg.toFixed(3);
            document.getElementById('min-latency').innerText = latencyStats.min.toFixed(3);
            document.getElementById('max-latency').innerText = latencyStats.max.toFixed(3);
            document.getElementById('p90-latency').innerText = p90.toFixed(3);
            document.getElementById('jitter').innerText = avgJitter.toFixed(3);
            
            statsUpdatePending = false;
        });
    }
}

const frequency_input = document.getElementById('frequency');
const size_input = document.getElementById('size');
const duration_input = document.getElementById('duration');

// 存储预设配置
let presetsData = {};

// 加载预设配置
fetch('presets.json')
    .then(response => {
        if (!response.ok) {
            throw new Error(`获取预设失败: ${response.status}`);
        }
        return response.json();
    })
    .then(data => {
        // 转换为键值对格式方便查找
        data.forEach(preset => {
            presetsData[preset.id] = preset;
        });
        
        // 填充预设下拉框
        const presetSelect = document.getElementById('preset');
        presetSelect.innerHTML = '';
        
        data.forEach(preset => {
            const option = document.createElement('option');
            option.value = preset.id;
            option.textContent = preset.name;
            option.title = preset.description; // 鼠标悬停显示描述
            presetSelect.appendChild(option);
        });
    })
    .catch(error => {
        console.error('加载预设配置失败:', error);
    });

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

// 同步滑条到输入框
const syncRangeToInput = (id) => {
    const rangeInput = document.getElementById(id);
    const numberInput = document.getElementById(`${id}-input`);
    numberInput.value = rangeInput.value;
    markAsCustom();
};

// 同步输入框到滑条
const syncInputToRange = (id) => {
    const rangeInput = document.getElementById(id);
    const numberInput = document.getElementById(`${id}-input`);
    
    // 验证输入值在范围内
    let value = parseInt(numberInput.value);
    const min = parseInt(numberInput.min);
    const max = parseInt(numberInput.max);
    
    if (isNaN(value)) {
        value = min;
    } else if (value < min) {
        value = min;
    } else if (value > max) {
        value = max;
    }
    
    numberInput.value = value;
    rangeInput.value = value;
    markAsCustom();
};

// 应用预设
const applyPreset = () => {
    const presetSelect = document.getElementById('preset');
    const presetValue = presetSelect.value;
    
    if (presetValue === 'custom') {
        return; // 自定义模式，不做任何改变
    }
    
    const preset = presetsData[presetValue];
    if (!preset) return;
    
    // 更新滑块和输入框的值
    document.getElementById('frequency').value = preset.frequency;
    document.getElementById('frequency-input').value = preset.frequency;
    
    document.getElementById('size').value = preset.size;
    document.getElementById('size-input').value = preset.size;
    
    document.getElementById('duration').value = preset.duration;
    document.getElementById('duration-input').value = preset.duration;
    
    // 显示预设描述
    console.log(`已应用预设: ${preset.name} - ${preset.description}`);
    if (preset.requirements) {
        console.log('质量要求:', preset.requirements);
    }
};

// 监听参数变化，如果手动修改则切换回自定义
const markAsCustom = () => {
    const presetSelect = document.getElementById('preset');
    if (presetSelect && presetSelect.value !== 'custom') {
        presetSelect.value = 'custom';
    }
};

// 切换压测模式
const toggleStressMode = () => {
    isStressMode = document.getElementById('stress-mode').checked;
    const durationGroup = document.getElementById('duration').parentElement.parentElement;
    
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

const maxsize = 16384; // 扩容到16KB

frequency_input.addEventListener("change", (event) => {
    const freqValue = parseInt(frequency_input.value);
    if (freqValue > 64) {
        duration_input.max = 300;
        size_input.max = 8192;
        
        document.getElementById('duration-input').max = 300;
        document.getElementById('size-input').max = 8192;
        
        if (parseInt(duration_input.value) > 300) {
            duration_input.value = 300;
            document.getElementById('duration-input').value = 300;
        }
        if (parseInt(size_input.value) > 8192) {
            size_input.value = 8192;
            document.getElementById('size-input').value = 8192;
        }
    } else {
        duration_input.max = 300;
        size_input.max = maxsize;
        
        document.getElementById('duration-input').max = 300;
        document.getElementById('size-input').max = maxsize;
    }
})

const setStatus = (status) => {
    document.getElementById('status').innerText = `状态: ${status}`;
};

const startSendingData = (frequency, size, totalPackets, duration) => {
    packetCount = 0;
    resetLatencyStats(); // 重置延迟统计
    
    if (isStressMode) {
        stressStartTime = performance.now();
    }
    
    // 启动图表更新定时器，每1秒更新一次
    if (chartUpdateIntervalId) {
        clearInterval(chartUpdateIntervalId);
    }
    chartUpdateIntervalId = setInterval(() => {
        updateChart();
    }, 500);
    
    // 使用高精度定时器 - 预先计算时间戳避免在循环中重复调用
    const intervalMs = 1000 / frequency;
    let nextSendTime = performance.now() + intervalMs;
    
    // 使用 setInterval 但通过时间校准来提高精度
    intervalId = setInterval(() => {
        const now = performance.now();
        
        // 如果我们落后了，尝试补发
        while (nextSendTime <= now) {
            // 压测模式下不检查 totalPackets
            if (!isStressMode && (packetCount >= totalPackets || dataChannel.readyState !== 'open')) {
                stopTest();
                return;
            }
            
            if (dataChannel.readyState !== 'open') {
                stopTest();
                return;
            }
            
            // 使用当前时间戳而不是预计算的，确保精度
            const timestamp = performance.now();
            const packet = `${packetCount},${timestamp}`;
            
            // 立即发送，减少缓冲
            dataChannel.send(packet);
            sentPacketTimes[packetCount] = { sentTime: timestamp, received: false };
            packetCount++;
            
            nextSendTime += intervalMs;
            
            // 避免无限循环，如果落后太多就跳过
            if (nextSendTime < now - intervalMs * 10) {
                nextSendTime = now + intervalMs;
                break;
            }
        }
        
        // 压测模式下，清理10秒前的数据
        if (isStressMode) {
            const currentTime = performance.now();
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
            ],
            // 优化配置以降低延迟
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require'
        };
        pc = new RTCPeerConnection(configuration);
        
        // 优化数据通道配置以最小化延迟
        dataChannel = pc.createDataChannel('dataChannel', { 
            ordered: false,           // 无序传输，减少延迟
            maxRetransmits: 0,        // 不重传，避免延迟累积
            negotiated: false,        // 协商模式
            protocol: '',             // 无特殊协议
            // 注意：bufferedAmountLowThreshold 在创建后设置
        });
        
        // 设置发送缓冲区低水位线，减少缓冲延迟
        dataChannel.bufferedAmountLowThreshold = 0;

        dataChannel.onopen = () => {
            console.log("数据通道已打开");
            setStatus('测试中...');
            
            // 尝试设置二进制类型为 arraybuffer（虽然我们用字符串）
            dataChannel.binaryType = 'arraybuffer';
            
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
            // 立即记录接收时间，最小化处理延迟
            const receiveTime = performance.now();
            
            // 使用更快的字符串分割
            const commaIndex = event.data.indexOf(',');
            const packetIndex = event.data.substring(0, commaIndex);
            const sentTime = parseFloat(event.data.substring(commaIndex + 1));
            
            const latency = receiveTime - sentTime;
            
            // 只有在记录中存在该包时才处理
            if (sentPacketTimes[packetIndex]) {
                // 更新实时统计（真实延迟，无滤波）
                updateLatencyStats(latency);
                
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
        const currentTime = performance.now();
        const cutoffTime = currentTime - 10000; // 10秒前
        
        // 获取所有有效的包索引并排序
        const validKeys = Object.keys(sentPacketTimes)
            .map(k => parseInt(k))
            .filter(k => sentPacketTimes[k] && sentPacketTimes[k].sentTime >= cutoffTime)
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