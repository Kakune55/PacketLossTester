(() => {
    const MAX_PACKET_SIZE = 16384;
    const STRESS_WINDOW_MS = 10000;
    const MAX_PERCENTILE_SAMPLES = 2000;
    const CHART_BUCKETS = 120;
    const CHART_UPDATE_INTERVAL_MS = 2000;
    const CHART_ANIMATION_MS = 220;

    const els = {
        frequency: document.getElementById('frequency'),
        frequencyInput: document.getElementById('frequency-input'),
        size: document.getElementById('size'),
        sizeInput: document.getElementById('size-input'),
        duration: document.getElementById('duration'),
        durationInput: document.getElementById('duration-input'),
        preset: document.getElementById('preset'),
        testNode: document.getElementById('testNode'),
        stressMode: document.getElementById('stress-mode'),
        startBtn: document.getElementById('start-btn'),
        stopBtn: document.getElementById('stop-btn'),
        status: document.getElementById('status'),
        sentPackets: document.getElementById('sent-packets'),
        receivedPackets: document.getElementById('received-packets'),
        packetLossRate: document.getElementById('packet-loss-rate'),
        avgLatency: document.getElementById('avg-latency'),
        minLatency: document.getElementById('min-latency'),
        maxLatency: document.getElementById('max-latency'),
        p90Latency: document.getElementById('p90-latency'),
        jitter: document.getElementById('jitter'),
        chart: document.getElementById('chart'),
    };

    let receivedPackets = 0;
    let dataChannel;
    let pc;
    let currentWebSocket;
    let intervalId;
    let chartUpdateIntervalId;
    let chartUpdateIdleId;
    let chartUpdatePending = false;
    let chartAnimationFrameId;
    let durationTimeoutId;
    let chart;
    let packetCount = 0;
    let isStressMode = false;
    let isTesting = false;
    let statsUpdatePending = false;
    let presetsData = {};
    const sentPacketTimes = {};

    let latencyStats = createLatencyStats();

    const createOption = (value, text, title = '') => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        if (title) {
            option.title = title;
        }
        return option;
    };

    function createLatencyStats() {
        return {
            min: Infinity,
            max: -Infinity,
            sum: 0,
            count: 0,
            values: [],
            lastLatency: null,
            jitterSum: 0,
            jitterCount: 0,
        };
    }

    const resetLatencyStats = () => {
        latencyStats = createLatencyStats();
        els.avgLatency.innerText = '-';
        els.minLatency.innerText = '-';
        els.maxLatency.innerText = '-';
        els.p90Latency.innerText = '-';
        els.jitter.innerText = '-';
    };

    const updateLatencyStats = (latency) => {
        latencyStats.sum += latency;
        latencyStats.count++;
        latencyStats.values.push(latency);

        if (latencyStats.lastLatency !== null) {
            latencyStats.jitterSum += Math.abs(latency - latencyStats.lastLatency);
            latencyStats.jitterCount++;
        }
        latencyStats.lastLatency = latency;

        if (latencyStats.values.length > MAX_PERCENTILE_SAMPLES) {
            latencyStats.values.shift();
        }

        latencyStats.min = Math.min(latencyStats.min, latency);
        latencyStats.max = Math.max(latencyStats.max, latency);

        if (statsUpdatePending) {
            return;
        }

        statsUpdatePending = true;
        requestAnimationFrame(() => {
            const avg = latencyStats.sum / latencyStats.count;
            const avgJitter = latencyStats.jitterCount > 0
                ? latencyStats.jitterSum / latencyStats.jitterCount
                : 0;
            const sorted = [...latencyStats.values].sort((a, b) => a - b);
            const p90 = sorted.length > 0 ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))] : 0;

            els.avgLatency.innerText = avg.toFixed(3);
            els.minLatency.innerText = latencyStats.min.toFixed(3);
            els.maxLatency.innerText = latencyStats.max.toFixed(3);
            els.p90Latency.innerText = p90.toFixed(3);
            els.jitter.innerText = avgJitter.toFixed(3);
            statsUpdatePending = false;
        });
    };

    const setStatus = (status) => {
        els.status.innerText = `状态: ${status}`;
    };

    const clearPacketTimes = () => {
        Object.keys(sentPacketTimes).forEach((key) => {
            delete sentPacketTimes[key];
        });
    };

    const closeActiveConnection = () => {
        if (dataChannel) {
            dataChannel.onopen = null;
            dataChannel.onmessage = null;
            dataChannel.onerror = null;
            try {
                dataChannel.close();
            } catch (error) {
                console.warn('关闭数据通道失败:', error);
            }
            dataChannel = null;
        }

        if (pc) {
            pc.onicecandidate = null;
            try {
                pc.close();
            } catch (error) {
                console.warn('关闭 PeerConnection 失败:', error);
            }
            pc = null;
        }

        if (currentWebSocket) {
            currentWebSocket.onopen = null;
            currentWebSocket.onmessage = null;
            currentWebSocket.onerror = null;
            currentWebSocket.onclose = null;
            try {
                currentWebSocket.close();
            } catch (error) {
                console.warn('关闭 WebSocket 失败:', error);
            }
            currentWebSocket = null;
        }
    };

    const buildPacket = (index, timestamp, size) => {
        const header = `${index},${timestamp}`;
        const requestedSize = parseInt(size, 10);
        const targetSize = Math.max(header.length, Math.min(requestedSize || header.length, MAX_PACKET_SIZE));
        if (targetSize === header.length) {
            return header;
        }
        return `${header},${'x'.repeat(Math.max(0, targetSize - header.length - 1))}`;
    };

    const markAsCustom = () => {
        if (els.preset && els.preset.value !== 'custom') {
            els.preset.value = 'custom';
        }
    };

    const clampNumberInput = (numberInput) => {
        let value = parseInt(numberInput.value, 10);
        const min = parseInt(numberInput.min, 10);
        const max = parseInt(numberInput.max, 10);

        if (Number.isNaN(value)) {
            value = min;
        } else if (value < min) {
            value = min;
        } else if (value > max) {
            value = max;
        }

        numberInput.value = value;
        return value;
    };

    const syncRangeToInput = (rangeInput, numberInput) => {
        numberInput.value = rangeInput.value;
        markAsCustom();
    };

    const syncInputToRange = (rangeInput, numberInput) => {
        rangeInput.value = clampNumberInput(numberInput);
        markAsCustom();
    };

    const applyFrequencyLimits = () => {
        const maxSize = parseInt(els.frequency.value, 10) > 64 ? 8192 : MAX_PACKET_SIZE;
        els.duration.max = 300;
        els.durationInput.max = 300;
        els.size.max = maxSize;
        els.sizeInput.max = maxSize;

        if (parseInt(els.duration.value, 10) > 300) {
            els.duration.value = 300;
            els.durationInput.value = 300;
        }
        if (parseInt(els.size.value, 10) > maxSize) {
            els.size.value = maxSize;
            els.sizeInput.value = maxSize;
        }
    };

    const applyPreset = () => {
        const presetValue = els.preset.value;
        if (presetValue === 'custom') {
            return;
        }

        const preset = presetsData[presetValue];
        if (!preset) {
            return;
        }

        els.frequency.value = preset.frequency;
        els.frequencyInput.value = preset.frequency;
        els.size.value = preset.size;
        els.sizeInput.value = preset.size;
        els.duration.value = preset.duration;
        els.durationInput.value = preset.duration;
        applyFrequencyLimits();
    };

    const toggleStressMode = () => {
        isStressMode = els.stressMode.checked;
        const durationGroup = els.duration.closest('.form-group');
        durationGroup.classList.toggle('is-disabled', isStressMode);
        els.duration.disabled = isStressMode;
        els.durationInput.disabled = isStressMode;
    };

    const loadPresets = async () => {
        try {
            const response = await fetch('presets.json');
            if (!response.ok) {
                throw new Error(`获取预设失败: ${response.status}`);
            }

            const data = await response.json();
            presetsData = Object.fromEntries(data.map((preset) => [preset.id, preset]));
            els.preset.replaceChildren(...data.map((preset) => (
                createOption(preset.id, preset.name, preset.description)
            )));
        } catch (error) {
            console.error('加载预设配置失败:', error);
        }
    };

    const loadNodes = async () => {
        els.startBtn.disabled = true;
        try {
            const response = await fetch('nodes.json');
            if (!response.ok) {
                throw new Error(`获取节点失败: ${response.status}`);
            }

            const data = await response.json();
            els.testNode.replaceChildren(...data.map((item) => createOption(item.url, item.name)));
            els.startBtn.disabled = data.length === 0;
        } catch (error) {
            console.error('加载节点失败:', error);
            setStatus(`节点加载失败: ${error.message}`);
        }
    };

    const scheduleChartUpdate = () => {
        if (chartUpdatePending) {
            return;
        }

        chartUpdatePending = true;
        const run = () => {
            chartUpdateIdleId = null;
            chartUpdatePending = false;
            updateChart();
        };

        if (window.requestIdleCallback) {
            chartUpdateIdleId = window.requestIdleCallback(run, { timeout: 1000 });
        } else {
            chartUpdateIdleId = window.setTimeout(run, 0);
        }
    };

    const cancelScheduledChartUpdate = () => {
        if (chartUpdateIdleId === undefined || chartUpdateIdleId === null) {
            return;
        }

        if (window.cancelIdleCallback) {
            window.cancelIdleCallback(chartUpdateIdleId);
        } else {
            window.clearTimeout(chartUpdateIdleId);
        }
        chartUpdateIdleId = null;
        chartUpdatePending = false;
    };

    const startSendingData = (frequency, size, totalPackets, duration) => {
        packetCount = 0;
        resetLatencyStats();

        cancelScheduledChartUpdate();
        if (chartUpdateIntervalId) {
            clearInterval(chartUpdateIntervalId);
        }
        chartUpdateIntervalId = setInterval(scheduleChartUpdate, CHART_UPDATE_INTERVAL_MS);

        const intervalMs = 1000 / frequency;
        let nextSendTime = performance.now() + intervalMs;

        intervalId = setInterval(() => {
            const now = performance.now();

            while (nextSendTime <= now) {
                if (!isStressMode && (packetCount >= totalPackets || dataChannel.readyState !== 'open')) {
                    stopTest();
                    return;
                }

                if (dataChannel.readyState !== 'open') {
                    stopTest();
                    return;
                }

                const timestamp = performance.now();
                try {
                    dataChannel.send(buildPacket(packetCount, timestamp, size));
                } catch (error) {
                    console.error('发送数据包失败:', error);
                    stopTest({ status: `发送失败: ${error.message}` });
                    return;
                }
                sentPacketTimes[packetCount] = { sentTime: timestamp, received: false };
                packetCount++;
                nextSendTime += intervalMs;

                if (nextSendTime < now - intervalMs * 10) {
                    nextSendTime = now + intervalMs;
                    break;
                }
            }

            if (isStressMode) {
                const cutoffTime = performance.now() - STRESS_WINDOW_MS;
                Object.keys(sentPacketTimes).forEach((key) => {
                    if (sentPacketTimes[key].sentTime < cutoffTime) {
                        delete sentPacketTimes[key];
                    }
                });
                els.sentPackets.innerText = Object.keys(sentPacketTimes).length;
            } else {
                els.sentPackets.innerText = packetCount;
            }
        }, intervalMs);

        if (!isStressMode) {
            durationTimeoutId = setTimeout(() => stopTest(), duration * 1000);
        }
    };

    const stopTest = ({ status = '测试完成', closeConnection = true } = {}) => {
        if (intervalId) {
            clearInterval(intervalId);
            intervalId = null;
        }
        if (chartUpdateIntervalId) {
            clearInterval(chartUpdateIntervalId);
            chartUpdateIntervalId = null;
        }
        cancelScheduledChartUpdate();
        if (durationTimeoutId) {
            clearTimeout(durationTimeoutId);
            durationTimeoutId = null;
        }

        isTesting = false;
        setStatus(status);
        els.startBtn.disabled = false;
        els.stopBtn.style.display = 'none';

        if (!isStressMode) {
            for (let i = 0; i < packetCount; i++) {
                if (sentPacketTimes[i] && !sentPacketTimes[i].received) {
                    sentPacketTimes[i].latency = -1;
                }
            }
        }
        updateChart();

        if (closeConnection) {
            closeActiveConnection();
        }
    };

    const handleWebSocketMessage = (ws) => async (event) => {
        let message;
        try {
            message = JSON.parse(event.data);
        } catch (error) {
            console.error('解析信令消息失败:', error);
            stopTest({ status: `信令解析失败: ${error.message}` });
            return;
        }

        if (message.candidate) {
            try {
                await pc.addIceCandidate(new RTCIceCandidate(message));
            } catch (error) {
                console.error('添加接收到的 ICE 候选者时出错', error);
            }
            return;
        }

        if (message.sdp) {
            try {
                await pc.setRemoteDescription(new RTCSessionDescription(message));
                if (message.type === 'offer') {
                    const answer = await pc.createAnswer();
                    await pc.setLocalDescription(answer);
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify(pc.localDescription));
                    }
                }
            } catch (error) {
                console.error('处理信令消息失败:', error);
                stopTest({ status: `信令处理失败: ${error.message}` });
            }
        }
    };

    const updatePacketCounters = (() => {
        let pending = false;
        return () => {
            if (pending) {
                return;
            }
            pending = true;
            requestAnimationFrame(() => {
                let totalSent;
                let receivedCount;

                if (isStressMode) {
                    const packetEntries = Object.values(sentPacketTimes);
                    totalSent = packetEntries.length;
                    receivedCount = packetEntries.filter((packet) => packet.received).length;
                } else {
                    totalSent = packetCount;
                    receivedCount = receivedPackets;
                }

                const lossRate = totalSent > 0 ? ((totalSent - receivedCount) / totalSent) * 100 : 0;
                els.receivedPackets.innerText = receivedCount;
                els.packetLossRate.innerText = `${lossRate.toFixed(2)}%`;
                pending = false;
            });
        };
    })();

    const handleDataChannelMessage = (event) => {
        if (typeof event.data !== 'string') {
            return;
        }
        const receiveTime = performance.now();
        const commaIndex = event.data.indexOf(',');
        if (commaIndex === -1) {
            return;
        }

        const packetIndex = event.data.substring(0, commaIndex);
        const secondCommaIndex = event.data.indexOf(',', commaIndex + 1);
        const sentTimeText = secondCommaIndex === -1
            ? event.data.substring(commaIndex + 1)
            : event.data.substring(commaIndex + 1, secondCommaIndex);
        const sentTime = parseFloat(sentTimeText);

        if (!Number.isFinite(sentTime) || !sentPacketTimes[packetIndex]) {
            return;
        }

        const latency = receiveTime - sentTime;
        updateLatencyStats(latency);

        if (!isStressMode && !sentPacketTimes[packetIndex].received) {
            receivedPackets++;
        }
        sentPacketTimes[packetIndex].received = true;
        sentPacketTimes[packetIndex].latency = latency;
        updatePacketCounters();
    };

    const getCssColor = (name) => getComputedStyle(document.documentElement)
        .getPropertyValue(name)
        .trim();

    const initializeChart = () => {
        const ctx = els.chart.getContext('2d');
        if (chartAnimationFrameId) {
            cancelAnimationFrame(chartAnimationFrameId);
            chartAnimationFrameId = null;
        }

        chart = {
            ctx,
            labels: [],
            avg: [],
            max: [],
            displayedAvg: [],
            displayedMax: [],
            colors: {
                text: getCssColor('--ui-text') || '#111111',
                muted: getCssColor('--ui-muted') || '#5f5a4f',
                border: getCssColor('--ui-border') || '#111111',
                avg: getCssColor('--ui-blue') || '#27ccf3',
                max: getCssColor('--ui-pink') || '#fe7da8',
                grid: 'rgba(17, 17, 17, 0.14)',
            },
        };
        drawChartFrame(chart.labels, chart.displayedAvg, chart.displayedMax);
    };

    const startTest = async () => {
        if (!els.testNode.value) {
            setStatus('没有可用测试节点');
            return;
        }

        els.startBtn.disabled = true;
        els.stopBtn.style.display = 'inline-flex';
        setStatus('建立连接中...');

        const frequency = parseInt(els.frequency.value, 10);
        const size = parseInt(els.size.value, 10);
        const duration = parseInt(els.duration.value, 10);
        const totalPackets = isStressMode ? Infinity : frequency * duration;

        isTesting = true;
        receivedPackets = 0;
        clearPacketTimes();
        els.sentPackets.innerText = '0';
        els.receivedPackets.innerText = '0';
        els.packetLossRate.innerText = '0%';

        try {
            currentWebSocket = new WebSocket(els.testNode.value);
        } catch (error) {
            stopTest({ status: `连接失败: ${error.message}` });
            return;
        }

        currentWebSocket.onopen = async () => {
            try {
                setStatus('连接已建立，准备建立数据通道测试...');

                pc = new RTCPeerConnection({
                    iceServers: [
                        { urls: 'stun:stun.l.google.com:19302' },
                        { urls: 'stun:stun1.l.google.com:19302' },
                    ],
                    bundlePolicy: 'max-bundle',
                    rtcpMuxPolicy: 'require',
                });

                dataChannel = pc.createDataChannel('dataChannel', {
                    ordered: false,
                    maxRetransmits: 0,
                    negotiated: false,
                    protocol: '',
                });
                dataChannel.bufferedAmountLowThreshold = 0;

                dataChannel.onopen = () => {
                    setStatus('测试中...');
                    dataChannel.binaryType = 'arraybuffer';
                    startSendingData(frequency, size, totalPackets, duration);
                };
                dataChannel.onmessage = handleDataChannelMessage;
                dataChannel.onerror = (event) => {
                    console.error('数据通道错误:', event);
                    stopTest({ status: '数据通道错误' });
                };

                pc.onicecandidate = (event) => {
                    if (event.candidate && currentWebSocket?.readyState === WebSocket.OPEN) {
                        currentWebSocket.send(JSON.stringify(event.candidate.toJSON()));
                    }
                };

                currentWebSocket.onmessage = handleWebSocketMessage(currentWebSocket);

                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                if (currentWebSocket.readyState === WebSocket.OPEN) {
                    currentWebSocket.send(JSON.stringify(pc.localDescription));
                }
                initializeChart();
            } catch (error) {
                console.error('启动 WebRTC 测试失败:', error);
                stopTest({ status: `连接失败: ${error.message}` });
            }
        };

        currentWebSocket.onerror = () => {
            stopTest({ status: '连接失败' });
        };

        currentWebSocket.onclose = () => {
            if (isTesting) {
                stopTest({ status: '连接关闭' });
            } else {
                currentWebSocket = null;
            }
        };
    };

    function updateChart() {
        if (!chart) {
            return;
        }

        const labels = [];
        const dataAvg = [];
        const dataMax = [];

        if (isStressMode) {
            const cutoffTime = performance.now() - STRESS_WINDOW_MS;
            const validKeys = Object.keys(sentPacketTimes)
                .map((key) => parseInt(key, 10))
                .filter((key) => sentPacketTimes[key] && sentPacketTimes[key].sentTime >= cutoffTime)
                .sort((a, b) => a - b);

            if (validKeys.length === 0) {
                return;
            }

            const minKey = validKeys[0];
            const maxKey = validKeys[validKeys.length - 1];
            const sampleSize = Math.max(1, Math.ceil((maxKey - minKey + 1) / CHART_BUCKETS));
            collectChartBuckets(minKey, maxKey + 1, sampleSize, labels, dataAvg, dataMax, (index) => {
                const seconds = ((index - minKey) / (parseInt(els.frequency.value, 10) || 32)).toFixed(1);
                return `${seconds}s`;
            });
        } else {
            const sampleSize = Math.max(1, Math.ceil(packetCount / CHART_BUCKETS));
            collectChartBuckets(0, Math.max(0, packetCount - 2), sampleSize, labels, dataAvg, dataMax, (index) => index);
        }

        animateChartUpdate(labels, dataAvg, dataMax);
    }

    const getInterpolatedValue = (fromValues, toValues, index, progress) => {
        const from = fromValues[index] ?? 0;
        const to = toValues[index] ?? 0;
        return from + (to - from) * progress;
    };

    const easeOutCubic = (value) => 1 - Math.pow(1 - value, 3);

    const animateChartUpdate = (labels, dataAvg, dataMax) => {
        if (!chart) {
            return;
        }

        if (chartAnimationFrameId) {
            cancelAnimationFrame(chartAnimationFrameId);
        }

        const fromAvg = chart.displayedAvg;
        const fromMax = chart.displayedMax;
        const start = performance.now();
        chart.labels = labels;
        chart.avg = dataAvg;
        chart.max = dataMax;

        const draw = (now) => {
            const progress = easeOutCubic(Math.min(1, (now - start) / CHART_ANIMATION_MS));
            chart.displayedAvg = dataAvg.map((_, index) => getInterpolatedValue(fromAvg, dataAvg, index, progress));
            chart.displayedMax = dataMax.map((_, index) => getInterpolatedValue(fromMax, dataMax, index, progress));
            drawChartFrame(labels, chart.displayedAvg, chart.displayedMax);

            if (progress < 1) {
                chartAnimationFrameId = requestAnimationFrame(draw);
                return;
            }
            chartAnimationFrameId = null;
        };

        chartAnimationFrameId = requestAnimationFrame(draw);
    };

    const drawChartFrame = (labels, dataAvg, dataMax) => {
        if (!chart) {
            return;
        }

        const canvas = els.chart;
        const rect = canvas.getBoundingClientRect();
        const cssWidth = Math.max(320, rect.width || canvas.width);
        const cssHeight = Math.max(220, rect.height || canvas.height);
        const dpr = window.devicePixelRatio || 1;
        const pixelWidth = Math.round(cssWidth * dpr);
        const pixelHeight = Math.round(cssHeight * dpr);

        if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
            canvas.width = pixelWidth;
            canvas.height = pixelHeight;
        }

        const { ctx, colors } = chart;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssWidth, cssHeight);

        const padding = {
            top: 34,
            right: 20,
            bottom: 36,
            left: 42,
        };
        const plotWidth = Math.max(1, cssWidth - padding.left - padding.right);
        const plotHeight = Math.max(1, cssHeight - padding.top - padding.bottom);
        const maxValue = Math.max(1, ...dataAvg, ...dataMax);
        const yMax = Math.max(1, Math.ceil(maxValue / 2) * 2);

        ctx.lineWidth = 1;
        ctx.font = '12px Inter, "Noto Sans SC", system-ui, sans-serif';
        ctx.textBaseline = 'middle';

        for (let i = 0; i <= 4; i++) {
            const value = (yMax / 4) * i;
            const y = padding.top + plotHeight - (value / yMax) * plotHeight;
            ctx.strokeStyle = colors.grid;
            ctx.beginPath();
            ctx.moveTo(padding.left, y);
            ctx.lineTo(padding.left + plotWidth, y);
            ctx.stroke();

            ctx.fillStyle = colors.muted;
            ctx.textAlign = 'right';
            ctx.fillText(Number.isInteger(value) ? `${value}` : value.toFixed(1), padding.left - 8, y);
        }

        ctx.strokeStyle = colors.border;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(padding.left, padding.top);
        ctx.lineTo(padding.left, padding.top + plotHeight);
        ctx.lineTo(padding.left + plotWidth, padding.top + plotHeight);
        ctx.stroke();

        drawChartLegend(cssWidth, colors);

        if (labels.length === 0) {
            ctx.fillStyle = colors.muted;
            ctx.textAlign = 'center';
            ctx.fillText('等待测试数据', padding.left + plotWidth / 2, padding.top + plotHeight / 2);
            return;
        }

        const step = plotWidth / labels.length;
        const outerBarWidth = Math.max(2, Math.min(10, step * 0.68));
        const innerBarWidth = Math.max(1, outerBarWidth * 0.62);

        labels.forEach((label, index) => {
            const x = padding.left + index * step + step / 2;
            const maxHeight = (dataMax[index] / yMax) * plotHeight;
            const avgHeight = (dataAvg[index] / yMax) * plotHeight;
            const baseY = padding.top + plotHeight;

            ctx.fillStyle = colors.max;
            ctx.fillRect(x - outerBarWidth / 2, baseY - maxHeight, outerBarWidth, maxHeight);
            ctx.fillStyle = colors.avg;
            ctx.fillRect(x - innerBarWidth / 2, baseY - avgHeight, innerBarWidth, avgHeight);
        });

        const labelEvery = Math.max(1, Math.ceil(labels.length / 12));
        ctx.fillStyle = colors.muted;
        ctx.textAlign = 'center';
        labels.forEach((label, index) => {
            if (index % labelEvery !== 0) {
                return;
            }
            const x = padding.left + index * step + step / 2;
            ctx.save();
            ctx.translate(x, padding.top + plotHeight + 18);
            ctx.rotate(-Math.PI / 5);
            ctx.fillText(String(label), 0, 0);
            ctx.restore();
        });
    };

    const drawChartLegend = (canvasWidth, colors) => {
        const { ctx } = chart;
        const items = [
            { label: '平均延迟 (ms)', color: colors.avg },
            { label: '最大延迟 (ms)', color: colors.max },
        ];
        ctx.font = '13px Inter, "Noto Sans SC", system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        const totalWidth = items.reduce((sum, item) => sum + ctx.measureText(item.label).width + 44, 0);
        let x = Math.max(12, (canvasWidth - totalWidth) / 2);

        items.forEach((item) => {
            ctx.fillStyle = item.color;
            ctx.fillRect(x, 13, 28, 10);
            x += 36;
            ctx.fillStyle = colors.muted;
            ctx.textAlign = 'left';
            ctx.fillText(item.label, x, 18);
            x += ctx.measureText(item.label).width + 18;
        });
    };

    function collectChartBuckets(start, end, sampleSize, labels, dataAvg, dataMax, makeLabel) {
        for (let i = start; i < end; i += sampleSize) {
            const endIndex = Math.min(i + sampleSize, end);
            let sumLatency = 0;
            let validCount = 0;
            let maxLatency = -Infinity;

            for (let j = i; j < endIndex; j++) {
                const packet = sentPacketTimes[j];
                const latency = packet?.latency;
                if (latency !== undefined && latency !== -1) {
                    sumLatency += latency;
                    validCount++;
                    maxLatency = Math.max(maxLatency, latency);
                }
            }

            if (validCount > 0) {
                labels.push(makeLabel(i));
                dataAvg.push(sumLatency / validCount);
                dataMax.push(maxLatency);
            }
        }
    }

    const bindInputPair = (rangeInput, numberInput) => {
        rangeInput.addEventListener('input', () => syncRangeToInput(rangeInput, numberInput));
        numberInput.addEventListener('input', () => syncInputToRange(rangeInput, numberInput));
    };

    bindInputPair(els.frequency, els.frequencyInput);
    bindInputPair(els.size, els.sizeInput);
    bindInputPair(els.duration, els.durationInput);
    els.frequency.addEventListener('change', applyFrequencyLimits);
    els.frequencyInput.addEventListener('change', applyFrequencyLimits);
    els.preset.addEventListener('change', applyPreset);
    els.stressMode.addEventListener('change', toggleStressMode);
    els.startBtn.addEventListener('click', startTest);
    els.stopBtn.addEventListener('click', () => {
        stopTest({ status: '测试已停止' });
    });

    els.stopBtn.style.display = 'none';
    loadPresets();
    loadNodes();
})();
