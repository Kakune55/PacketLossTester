(() => {
    const MAX_PACKET_SIZE = 16384;
    const { Measurement, REPLY_TIMEOUT_MS, MAX_BUFFERED_BYTES } = window.PacketMeasurement;
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
    let presetsData = {};
    let measurement = new Measurement();
    let activeRun;
    let statsIntervalId;
    let drainTimeoutId;
    let connectionTimeoutId;

    const lockControls = (locked) => {
        [els.frequency, els.frequencyInput, els.size, els.sizeInput,
            els.duration, els.durationInput, els.preset, els.testNode, els.stressMode]
            .forEach((el) => { el.disabled = locked; });
        if (!locked) toggleStressMode();
    };

    const createOption = (value, text, title = '') => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        if (title) {
            option.title = title;
        }
        return option;
    };

    const renderStats = () => {
        const stats = measurement.snapshot(performance.now());
        els.sentPackets.innerText = stats.sent;
        els.receivedPackets.innerText = stats.received;
        document.getElementById('pending-packets').innerText = stats.pending;
        els.packetLossRate.innerText = stats.lossRate === null ? '-' : `${stats.lossRate.toFixed(2)}%`;
        for (const [key, el] of [['avg', els.avgLatency], ['min', els.minLatency],
            ['max', els.maxLatency], ['p90', els.p90Latency], ['jitter', els.jitter]]) {
            el.innerText = stats[key] === null ? '-' : stats[key].toFixed(3);
        }
    };

    const setStatus = (status) => {
        els.status.innerText = `状态: ${status}`;
    };

    const closeActiveConnection = () => {
        if (dataChannel) {
            dataChannel.onopen = null;
            dataChannel.onmessage = null;
            dataChannel.onerror = null;
            dataChannel.onclose = null;
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
        if (isTesting) return;
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
        if (isTesting) return;
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
            els.startBtn.disabled = isTesting || data.length === 0;
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
        const runIdentity = activeRun;
        const run = () => {
            if (runIdentity !== activeRun) return;
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
        if (!measurement.start()) return;
        clearTimeout(connectionTimeoutId);
        const run = activeRun;

        cancelScheduledChartUpdate();
        if (chartUpdateIntervalId) {
            clearInterval(chartUpdateIntervalId);
        }
        chartUpdateIntervalId = setInterval(() => {
            if (run === activeRun) scheduleChartUpdate();
        }, CHART_UPDATE_INTERVAL_MS);

        const intervalMs = 1000 / frequency;
        let nextSendTime = performance.now();

        const sendDuePackets = () => {
            if (run !== activeRun || measurement.phase !== 'sending') return;
            const now = performance.now();
            measurement.advance(now);

            while (nextSendTime <= now) {
                if (!run.config.stress && packetCount >= totalPackets) {
                    stopTest();
                    return;
                }

                if (dataChannel.readyState !== 'open') {
                    stopTest({ status: '测试异常：数据通道不可发送' });
                    return;
                }

                const timestamp = performance.now();
                try {
                    const packet = buildPacket(packetCount, timestamp, size);
                    if (dataChannel.bufferedAmount + packet.length > MAX_BUFFERED_BYTES) {
                        stopTest({ status: '测试异常：本地发送积压超过 1 MiB，结果不代表纯网络丢包' });
                        return;
                    }
                    dataChannel.send(packet);
                } catch (error) {
                    console.error('发送数据包失败:', error);
                    stopTest({ status: `发送失败: ${error.message}` });
                    return;
                }
                measurement.send(packetCount, timestamp);
                packetCount++;
                nextSendTime += intervalMs;

                if (nextSendTime < now - intervalMs * 10) {
                    nextSendTime = now + intervalMs;
                    break;
                }
            }

        };
        intervalId = setInterval(sendDuePackets, intervalMs);

        if (!run.config.stress) {
            durationTimeoutId = setTimeout(() => {
                if (run === activeRun) stopTest();
            }, duration * 1000);
        }
        // Send at t=0 so the final packet is not racing the duration timeout.
        sendDuePackets();
    };

    const stopTest = ({ status = '测试完成' } = {}) => {
        if (!isTesting) return;
        if (measurement.phase === 'draining') {
            if (status !== '测试完成' && status !== '测试已停止') {
                activeRun.finalStatus = status;
                setStatus(`${status}；等待已发送包结算...`);
            }
            return;
        }
        if (!measurement.stop(performance.now())) return;
        activeRun.finalStatus = status;
        clearTimeout(connectionTimeoutId);
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

        els.stopBtn.disabled = true;
        setStatus(`${status}；停止发送，等待回包（最多 3 秒）...`);
        renderStats();
        const run = activeRun;
        drainTimeoutId = setTimeout(() => {
            if (run === activeRun) finalizeTest();
        }, REPLY_TIMEOUT_MS);
        finalizeTest();
    };

    const finalizeTest = () => {
        if (!measurement.finish(performance.now())) return;
        clearTimeout(drainTimeoutId);
        clearInterval(statsIntervalId);
        renderStats();
        updateChart();
        setStatus(activeRun.finalStatus);
        isTesting = false;
        activeRun = null;
        closeActiveConnection();
        lockControls(false);
        els.startBtn.disabled = !els.testNode.value;
        els.stopBtn.style.display = 'none';
    };

    const handleWebSocketMessage = (ws, peer, run) => async (event) => {
        if (run !== activeRun) return;
        let message;
        try {
            message = JSON.parse(event.data);
            if (!message || typeof message !== 'object') throw new Error('无效的信令消息');
        } catch (error) {
            console.error('解析信令消息失败:', error);
            stopTest({ status: `信令解析失败: ${error.message}` });
            return;
        }

        if (message.candidate) {
            try {
                if (!peer.remoteDescription) {
                    if (run.remoteCandidates.length >= 256) throw new Error('ICE 候选数量超限');
                    run.remoteCandidates.push(message);
                    return;
                }
                await peer.addIceCandidate(new RTCIceCandidate(message));
            } catch (error) {
                if (run !== activeRun) return;
                console.error('添加接收到的 ICE 候选者时出错', error);
                stopTest({ status: `ICE 信令失败: ${error.message}` });
            }
            return;
        }

        if (message.sdp) {
            try {
                await peer.setRemoteDescription(new RTCSessionDescription(message));
                if (run !== activeRun) return;
                for (const candidate of run.remoteCandidates.splice(0)) {
                    await peer.addIceCandidate(new RTCIceCandidate(candidate));
                    if (run !== activeRun) return;
                }
                if (message.type === 'offer') {
                    const answer = await peer.createAnswer();
                    if (run !== activeRun) return;
                    await peer.setLocalDescription(answer);
                    if (run !== activeRun) return;
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify(peer.localDescription));
                    }
                }
            } catch (error) {
                if (run !== activeRun) return;
                console.error('处理信令消息失败:', error);
                stopTest({ status: `信令处理失败: ${error.message}` });
            }
        }
    };

    const handleDataChannelMessage = (event) => {
        if (typeof event.data !== 'string') {
            return;
        }
        const receiveTime = performance.now();
        const commaIndex = event.data.indexOf(',');
        if (commaIndex === -1) {
            return;
        }

        const packetIndexText = event.data.substring(0, commaIndex);
        if (!/^\d+$/.test(packetIndexText)) return;
        const packetIndex = Number(packetIndexText);
        const secondCommaIndex = event.data.indexOf(',', commaIndex + 1);
        const sentTimeText = secondCommaIndex === -1
            ? event.data.substring(commaIndex + 1)
            : event.data.substring(commaIndex + 1, secondCommaIndex);
        const sentTime = Number(sentTimeText);

        if (!sentTimeText.trim() || !Number.isFinite(sentTime) || !Number.isSafeInteger(packetIndex)) {
            return;
        }

        measurement.receive(packetIndex, sentTime, receiveTime);
        if (measurement.phase === 'draining') finalizeTest();
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
        if (isTesting) return;
        if (!els.testNode.value) {
            setStatus('没有可用测试节点');
            return;
        }

        els.startBtn.disabled = true;
        els.stopBtn.disabled = false;
        els.stopBtn.style.display = 'inline-flex';
        setStatus('建立连接中...');

        const frequency = clampNumberInput(els.frequencyInput);
        els.frequency.value = frequency;
        applyFrequencyLimits();
        const size = clampNumberInput(els.sizeInput);
        const duration = clampNumberInput(els.durationInput);
        isStressMode = els.stressMode.checked;
        const totalPackets = isStressMode ? Infinity : frequency * duration;

        isTesting = true;
        lockControls(true);
        const run = {
            config: Object.freeze({ frequency, size, duration, stress: isStressMode, node: els.testNode.value }),
            remoteCandidates: [], localCandidates: [], offerSent: false,
        };
        activeRun = run;
        packetCount = 0;
        measurement = new Measurement({ stress: run.config.stress });
        initializeChart();
        renderStats();
        statsIntervalId = setInterval(() => {
            if (run !== activeRun) return;
            renderStats();
            if (measurement.phase === 'draining') finalizeTest();
        }, 1000);
        connectionTimeoutId = setTimeout(() => {
            if (run === activeRun) stopTest({ status: '连接超时（15 秒）' });
        }, 15000);

        try {
            currentWebSocket = new WebSocket(run.config.node);
        } catch (error) {
            stopTest({ status: `连接失败: ${error.message}` });
            return;
        }

        const ws = currentWebSocket;
        ws.onopen = async () => {
            if (run !== activeRun || measurement.phase !== 'connecting') return;
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
                const peer = pc;

                dataChannel = peer.createDataChannel('dataChannel', {
                    ordered: false,
                    maxRetransmits: 0,
                    negotiated: false,
                    protocol: '',
                });
                dataChannel.bufferedAmountLowThreshold = 0;
                const channel = dataChannel;

                dataChannel.onopen = () => {
                    if (run !== activeRun || measurement.phase !== 'connecting') return;
                    setStatus('测试中...');
                    channel.binaryType = 'arraybuffer';
                    startSendingData(frequency, size, totalPackets, duration);
                };
                dataChannel.onmessage = (event) => {
                    if (run === activeRun) handleDataChannelMessage(event);
                };
                dataChannel.onerror = (event) => {
                    if (run !== activeRun) return;
                    console.error('数据通道错误:', event);
                    stopTest({ status: '数据通道错误' });
                };
                dataChannel.onclose = () => {
                    if (run === activeRun) stopTest({ status: '测试异常：数据通道关闭' });
                };

                peer.onicecandidate = (event) => {
                    if (run === activeRun && event.candidate && ws.readyState === WebSocket.OPEN) {
                        const candidate = event.candidate.toJSON();
                        if (run.offerSent) ws.send(JSON.stringify(candidate));
                        else run.localCandidates.push(candidate);
                    }
                };

                ws.onmessage = handleWebSocketMessage(ws, peer, run);

                const offer = await peer.createOffer();
                if (run !== activeRun) return;
                await peer.setLocalDescription(offer);
                if (run !== activeRun) return;
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify(peer.localDescription));
                    run.offerSent = true;
                    for (const candidate of run.localCandidates.splice(0)) ws.send(JSON.stringify(candidate));
                }
            } catch (error) {
                if (run !== activeRun) return;
                console.error('启动 WebRTC 测试失败:', error);
                stopTest({ status: `连接失败: ${error.message}` });
            }
        };

        ws.onerror = () => {
            if (run !== activeRun) return;
            stopTest({ status: '连接失败' });
        };

        ws.onclose = (event) => {
            if (run !== activeRun) return;
            if (isTesting) {
                stopTest({ status: event?.code === 1013
                    ? '测试异常：服务端回显积压，结果不代表纯网络丢包'
                    : '连接关闭' });
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
            measurement.advance(performance.now());
            const minKey = measurement.queue[measurement.head]?.id ?? packetCount;
            const maxKey = packetCount - 1;
            const sampleSize = Math.max(1, Math.ceil((maxKey - minKey + 1) / CHART_BUCKETS));
            collectChartBuckets(minKey, maxKey + 1, sampleSize, labels, dataAvg, dataMax, (index) => {
                const seconds = ((index - minKey) / (activeRun?.config.frequency || 32)).toFixed(1);
                return `${seconds}s`;
            });
        } else {
            const sampleSize = Math.max(1, Math.ceil(packetCount / CHART_BUCKETS));
            collectChartBuckets(0, packetCount, sampleSize, labels, dataAvg, dataMax, (index) => index);
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
        const targetChart = chart;
        const start = performance.now();
        chart.labels = labels;
        chart.avg = dataAvg;
        chart.max = dataMax;

        const draw = (now) => {
            if (targetChart !== chart) return;
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
            { label: '平均应用层 RTT (ms)', color: colors.avg },
            { label: '最大应用层 RTT (ms)', color: colors.max },
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
                const packet = measurement.packets.get(j);
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
