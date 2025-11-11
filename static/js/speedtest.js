const statusEl = document.getElementById("status");
const downloadEl = document.getElementById("download-speed");
const uploadEl = document.getElementById("upload-speed");
const latencyEl = document.getElementById("latency");
const startBtn = document.getElementById("start-test");
const caseResultsBody = document.getElementById("case-results-body");
const progressFill = document.getElementById("progress-fill");
const progressLabel = document.getElementById("progress-label");
const progressHint = document.getElementById("progress-hint");

const STANDARD_TOTAL_BYTES = 30 * 1024 * 1024; // 常规场景保持约 30 MB 数据量
const PEAK_DOWNLOAD_TOTAL_BYTES = 100 * 1024 * 1024;
const PEAK_UPLOAD_TOTAL_BYTES = 30 * 1024 * 1024;

const TEST_CASES = [
    {
        key: "100kb",
        label: "100 KB",
        displayLabel: "100 KB",
        download: { packetBytes: 100 * 1024, totalBytes: STANDARD_TOTAL_BYTES },
        upload: { packetBytes: 100 * 1024, totalBytes: STANDARD_TOTAL_BYTES },
    },
    {
        key: "500kb",
        label: "500 KB",
        displayLabel: "500 KB",
        download: { packetBytes: 500 * 1024, totalBytes: STANDARD_TOTAL_BYTES },
        upload: { packetBytes: 500 * 1024, totalBytes: STANDARD_TOTAL_BYTES },
    },
    {
        key: "1mb",
        label: "1 MB",
        displayLabel: "1 MB",
        download: { packetBytes: 1024 * 1024, totalBytes: STANDARD_TOTAL_BYTES },
        upload: { packetBytes: 1024 * 1024, totalBytes: STANDARD_TOTAL_BYTES },
    },
    {
        key: "10mb",
        label: "10 MB",
        displayLabel: "10 MB",
        download: { packetBytes: 10 * 1024 * 1024, totalBytes: STANDARD_TOTAL_BYTES },
        upload: { packetBytes: 10 * 1024 * 1024, totalBytes: STANDARD_TOTAL_BYTES },
    },
    {
        key: "peak",
        label: "极限大包",
        displayLabel: "下载 100 MB / 上传 30 MB",
        download: { packetBytes: PEAK_DOWNLOAD_TOTAL_BYTES, totalBytes: PEAK_DOWNLOAD_TOTAL_BYTES },
        upload: { packetBytes: PEAK_UPLOAD_TOTAL_BYTES, totalBytes: PEAK_UPLOAD_TOTAL_BYTES },
    },
];

const SUMMARY_CASE = TEST_CASES[TEST_CASES.length - 1];
const caseRows = new Map();
const describeStage = (direction, label, totalBytes) => {
    if (!totalBytes || totalBytes <= 0) {
        return `${direction} ${label}`;
    }
    const totalMB = totalBytes / (1024 * 1024);
    const rounded = Math.round(totalMB);
    const display = Math.abs(totalMB - rounded) < 1e-3 ? `${rounded} MB` : `${totalMB.toFixed(1)} MB`;
    return `${direction} ${label}（累计 ${display}）`;
};

const stageDescriptions = [
    "延迟探测",
    ...TEST_CASES.map(({ label, displayLabel, download }) => {
        const name = displayLabel ?? label;
        return describeStage("下载", name, download.totalBytes);
    }),
    ...TEST_CASES.map(({ label, displayLabel, upload }) => {
        const name = displayLabel ?? label;
        return describeStage("上传", name, upload.totalBytes);
    }),
];
const totalStages = stageDescriptions.length;
let completedStages = 0;

const clamp01 = (value) => Math.min(Math.max(value, 0), 1);

const updateProgressState = (state, options = {}) => {
    if (!progressFill || !progressLabel || !progressHint || !startBtn) {
        return;
    }

    if (state === "idle") {
        progressFill.style.width = "0%";
        progressLabel.textContent = "开始测速";
        progressHint.textContent = "点击启动全流程带宽测试";
        startBtn.classList.remove("is-active", "is-filled", "is-error");
        return;
    }

    const completed = options.completed ?? completedStages;
    const nextStage = options.nextStage ?? stageDescriptions[Math.min(completed, totalStages - 1)] ?? "收尾中";
    const fraction = clamp01(totalStages === 0 ? 1 : completed / totalStages);

    if (state === "running") {
        const width = completed === 0 ? 8 : Math.min(100, Math.max(18, fraction * 100));
        progressFill.style.width = `${width}%`;
        const percent = completed === 0 ? 5 : Math.min(99, Math.max(5, Math.round(fraction * 100)));
        progressLabel.textContent = `测速进行中 · ${percent}%`;
        progressHint.textContent = `阶段 ${Math.min(completed + 1, totalStages)}/${totalStages || 1} · ${nextStage}`;
        startBtn.classList.add("is-active");
        startBtn.classList.toggle("is-filled", width >= 60 || fraction >= 0.6);
        startBtn.classList.remove("is-error");
        return;
    }

    if (state === "completed") {
        progressFill.style.width = "100%";
        progressLabel.textContent = "测速完成";
        progressHint.textContent = "点击重新开始以再次测试";
        startBtn.classList.add("is-active", "is-filled");
        startBtn.classList.remove("is-error");
        return;
    }

    if (state === "error") {
        const width = completed === 0 ? 8 : Math.min(100, Math.max(18, fraction * 100));
        progressFill.style.width = `${width}%`;
        progressLabel.textContent = "测速失败";
        progressHint.textContent = options.message ?? "请检查网络连接后重试";
        startBtn.classList.add("is-active");
        startBtn.classList.remove("is-filled");
        startBtn.classList.add("is-error");
    }
};

const announceStageStart = () => {
    updateProgressState("running", {
        completed: completedStages,
        nextStage: stageDescriptions[Math.min(completedStages, totalStages - 1)],
    });
};

const markStageComplete = () => {
    completedStages = Math.min(completedStages + 1, totalStages);
    const nextStage = completedStages >= totalStages ? undefined : stageDescriptions[completedStages];
    updateProgressState("running", {
        completed: completedStages,
        nextStage,
    });
};

const resetProgress = () => {
    completedStages = 0;
    updateProgressState("idle");
};

const formatNumber = (value, fractionDigits = 2) => {
    if (!Number.isFinite(value) || value <= 0) {
        return "-";
    }
    return value.toFixed(fractionDigits);
};

const setStatus = (message) => {
    statusEl.textContent = `状态：${message}`;
};

const updateMetric = (element, value) => {
    element.textContent = formatNumber(value);
};

const initializeCaseTable = () => {
    if (!caseResultsBody || caseRows.size > 0) {
        return;
    }

    TEST_CASES.forEach((testCase) => {
        const row = document.createElement("tr");
        const sizeCell = document.createElement("td");
        sizeCell.textContent = testCase.displayLabel ?? testCase.label;

        const downloadCell = document.createElement("td");
        downloadCell.textContent = "-";

        const uploadCell = document.createElement("td");
        uploadCell.textContent = "-";

        row.append(sizeCell, downloadCell, uploadCell);
        caseResultsBody.appendChild(row);
        caseRows.set(testCase.key, { downloadCell, uploadCell });
    });
};

const setCaseResult = (key, type, value) => {
    const row = caseRows.get(key);
    if (!row) {
        return;
    }
    const targetCell = type === "download" ? row.downloadCell : row.uploadCell;
    targetCell.textContent = formatNumber(value);
};

const resetCaseResults = () => {
    TEST_CASES.forEach(({ key }) => {
        setCaseResult(key, "download", NaN);
        setCaseResult(key, "upload", NaN);
    });
};

const measureLatency = async () => {
    const attempts = 3;
    let total = 0;
    for (let i = 0; i < attempts; i++) {
        const start = performance.now();
        const response = await fetch(`/speedtest/ping?ts=${Date.now()}`, { cache: "no-store" });
        if (!response.ok) {
            throw new Error("Ping 请求失败");
        }
        await response.json();
        total += performance.now() - start;
    }
    return total / attempts;
};

const runDownloadTest = async (packetBytes, totalBytes) => {
    const packetSize = Math.max(1, Math.floor(packetBytes));
    // 保证每个场景传输的总数据量为 totalBytes（由调用者传入），避免小包场景只测一次导致突发性能。
    const targetBytes = Math.max(1, Math.floor(totalBytes));
    let remaining = targetBytes;
    let receivedTotal = 0;
    const start = performance.now();

    while (remaining > 0) {
        const chunkBytes = Math.min(packetSize, remaining);
        const response = await fetch(`/speedtest/download?bytes=${chunkBytes}`, {
            cache: "no-store",
        });
        if (!response.ok) {
            throw new Error("下载测试请求失败");
        }

        if (response.body && response.body.getReader) {
            const reader = response.body.getReader();
            while (true) {
                const { value, done } = await reader.read();
                if (done) {
                    break;
                }
                if (value) {
                    receivedTotal += value.length;
                }
            }
        } else {
            const buffer = await response.arrayBuffer();
            receivedTotal += buffer.byteLength;
        }

        remaining -= chunkBytes;
    }

    const durationSec = (performance.now() - start) / 1000;
    if (durationSec <= 0) {
        return NaN;
    }
    return (receivedTotal * 8) / durationSec / 1_000_000;
};

const fillRandomBytes = (target) => {
    if (window.crypto && window.crypto.getRandomValues) {
        const chunkSize = 65536; // Web Crypto fills at most 65536 bytes per call
        for (let offset = 0; offset < target.length; offset += chunkSize) {
            const end = Math.min(offset + chunkSize, target.length);
            window.crypto.getRandomValues(target.subarray(offset, end));
        }
    } else {
        for (let i = 0; i < target.length; i++) {
            target[i] = Math.floor(Math.random() * 256);
        }
    }
};

const runUploadTest = async (packetBytes, totalBytes) => {
    const packetSize = Math.max(1, Math.floor(packetBytes));
    // 保证每个场景传输的总数据量为 totalBytes（由调用者传入），避免小包场景只测一次导致突发性能。
    const targetBytes = Math.max(1, Math.floor(totalBytes));
    let remaining = targetBytes;
    let uploadedTotal = 0;
    const start = performance.now();

    while (remaining > 0) {
        const chunkBytes = Math.min(packetSize, remaining);
        const payload = new Uint8Array(chunkBytes);
        fillRandomBytes(payload);

        const response = await fetch("/speedtest/upload", {
            method: "POST",
            body: payload,
            headers: {
                "Content-Type": "application/octet-stream",
            },
        });
        if (!response.ok) {
            throw new Error("上传测试请求失败");
        }
        const result = await response.json();
        uploadedTotal += typeof result.receivedBytes === "number" ? result.receivedBytes : chunkBytes;

        remaining -= chunkBytes;
    }

    const durationSec = (performance.now() - start) / 1000;
    if (durationSec <= 0) {
        return NaN;
    }
    return (uploadedTotal * 8) / durationSec / 1_000_000;
};

initializeCaseTable();
resetProgress();

startBtn.addEventListener("click", async () => {
    if (startBtn.disabled) {
        return;
    }
    startBtn.blur();
    startBtn.disabled = true;
    initializeCaseTable();
    resetCaseResults();
    resetProgress();
    setStatus("正在测速，请稍候...");
    updateMetric(downloadEl, NaN);
    updateMetric(uploadEl, NaN);
    updateMetric(latencyEl, NaN);

    if (totalStages > 0) {
        announceStageStart();
    }

    try {
        setStatus("测量延迟...");
        const latency = await measureLatency();
        updateMetric(latencyEl, latency);
        markStageComplete();

        const downloadResults = new Map();
        for (const testCase of TEST_CASES) {
            announceStageStart();
            const label = testCase.displayLabel ?? testCase.label;
            setStatus(`测试下载速度（${label}）...`);
            const { packetBytes, totalBytes } = testCase.download;
            const downloadMbps = await runDownloadTest(packetBytes, totalBytes);
            downloadResults.set(testCase.key, downloadMbps);
            setCaseResult(testCase.key, "download", downloadMbps);
            markStageComplete();
        }

        const uploadResults = new Map();
        for (const testCase of TEST_CASES) {
            announceStageStart();
            const label = testCase.displayLabel ?? testCase.label;
            setStatus(`测试上传速度（${label}）...`);
            const { packetBytes, totalBytes } = testCase.upload;
            const uploadMbps = await runUploadTest(packetBytes, totalBytes);
            uploadResults.set(testCase.key, uploadMbps);
            setCaseResult(testCase.key, "upload", uploadMbps);
            markStageComplete();
        }

        updateMetric(downloadEl, downloadResults.get(SUMMARY_CASE.key));
        updateMetric(uploadEl, uploadResults.get(SUMMARY_CASE.key));
        updateProgressState("completed");
        setStatus("测速完成");
    } catch (error) {
        console.error(error);
        updateProgressState("error", { message: error.message });
        setStatus(`测速失败：${error.message}`);
    } finally {
        startBtn.disabled = false;
    }
});
