const statusEl = document.getElementById("status");
const downloadEl = document.getElementById("download-speed");
const uploadEl = document.getElementById("upload-speed");
const latencyEl = document.getElementById("latency");
const startBtn = document.getElementById("start-test");
const caseResultsBody = document.getElementById("case-results-body");
const progressFill = document.getElementById("progress-fill");
const progressLabel = document.getElementById("progress-label");
const progressHint = document.getElementById("progress-hint");
const highSpeedModeEl = document.getElementById("high-speed-mode");
const trafficSummaryEl = document.getElementById("traffic-summary");

const STANDARD_TOTAL_BYTES = 30 * 1024 * 1024; // 常规场景保持约 30 MB 数据量
const PEAK_DOWNLOAD_TOTAL_BYTES = 100 * 1024 * 1024;
const PEAK_UPLOAD_TOTAL_BYTES = 30 * 1024 * 1024;
const HIGH_SPEED_MULTIPLIER = 10;
const REQUEST_TIMEOUT_MS = 125_000;
let activeController = null;
let activeXHR = null;
let lastProgressRender = 0;
let runNode = null;
let cancelled = false;
let requestSequence = 0;

const testEndpoint = (path) => window.TestNodes.endpoint(runNode ?? nodePicker.selected, path);

const cancelRequests = () => {
    cancelled = true;
    activeController?.abort();
    activeXHR?.abort();
};
window.addEventListener("pagehide", cancelRequests);
document.getElementById("cancel-test").addEventListener("click", cancelRequests);

const withTimedFetch = async (url, consume, timeout = REQUEST_TIMEOUT_MS) => {
    if (cancelled) throw new Error("请求已取消或超时");
    const controller = new AbortController();
    activeController = controller;
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, { cache: "no-store", credentials: "omit", signal: controller.signal });
        if (!response.ok) throw new Error(`测速请求失败 (${response.status})`);
        return await consume(response);
    } catch (error) {
        if (controller.signal.aborted) throw new Error("请求已取消或超时");
        throw error;
    } finally {
        controller.abort();
        clearTimeout(timer);
        activeController = null;
    }
};

const BASE_TEST_CASES = [
    {
        key: "100kb",
        label: "100 KB",
        displayLabel: "100 KB · 代码资源",
        download: { resourceBytes: 100 * 1024, totalBytes: STANDARD_TOTAL_BYTES },
        upload: { resourceBytes: 100 * 1024, totalBytes: STANDARD_TOTAL_BYTES },
    },
    {
        key: "500kb",
        label: "500 KB",
        displayLabel: "500 KB · 小图片",
        download: { resourceBytes: 500 * 1024, totalBytes: STANDARD_TOTAL_BYTES },
        upload: { resourceBytes: 500 * 1024, totalBytes: STANDARD_TOTAL_BYTES },
    },
    {
        key: "1mb",
        label: "1 MB",
        displayLabel: "1 MB · 大图片",
        download: { resourceBytes: 1024 * 1024, totalBytes: STANDARD_TOTAL_BYTES },
        upload: { resourceBytes: 1024 * 1024, totalBytes: STANDARD_TOTAL_BYTES },
    },
    {
        key: "10mb",
        label: "10 MB",
        displayLabel: "10 MB · 文件",
        download: { resourceBytes: 10 * 1024 * 1024, totalBytes: STANDARD_TOTAL_BYTES },
        upload: { resourceBytes: 10 * 1024 * 1024, totalBytes: STANDARD_TOTAL_BYTES },
    },
    {
        key: "peak",
        label: "大流量场景",
        displayLabel: "大资源吞吐参考（下载 100 MB / 上传 30 MB）",
        download: { resourceBytes: PEAK_DOWNLOAD_TOTAL_BYTES, totalBytes: PEAK_DOWNLOAD_TOTAL_BYTES },
        upload: { resourceBytes: PEAK_UPLOAD_TOTAL_BYTES, totalBytes: PEAK_UPLOAD_TOTAL_BYTES },
    },
];

const SUMMARY_CASE = BASE_TEST_CASES[BASE_TEST_CASES.length - 1];
const caseRows = new Map();
let activeTestCases = BASE_TEST_CASES;
let stageDescriptions = [];
let totalStages = 0;
let totalTransferBytes = 0;
let totalProgressUnits = 1;
let completedStages = 0;
let completedProgressUnits = 0;
const uploadPayloadCache = new Map();

const getTrafficMultiplier = () => (highSpeedModeEl?.checked ? HIGH_SPEED_MULTIPLIER : 1);

const getTestCases = () => {
    const multiplier = getTrafficMultiplier();
    const plan = ({ resourceBytes, totalBytes }) => {
        const count = Math.ceil(totalBytes / resourceBytes) * multiplier;
        return { resourceBytes, count, totalBytes: count * resourceBytes };
    };
    return BASE_TEST_CASES.map((testCase) => ({
        ...testCase,
        download: plan(testCase.download),
        upload: plan(testCase.upload),
    }));
};

const describeStage = (direction, label, totalBytes) => {
    if (!totalBytes || totalBytes <= 0) {
        return `${direction} ${label}`;
    }
    const totalMB = totalBytes / (1024 * 1024);
    const rounded = Math.round(totalMB);
    const display = Math.abs(totalMB - rounded) < 1e-3 ? `${rounded} MB` : `${totalMB.toFixed(1)} MB`;
    return `${direction} ${label}（累计 ${display}）`;
};

const getStageDescriptions = (testCases) => [
    "延迟探测",
    ...testCases.map(({ label, displayLabel, download }) => {
        const name = displayLabel ?? label;
        return describeStage("下载", name, download.totalBytes);
    }),
    ...testCases.map(({ label, displayLabel, upload }) => {
        const name = displayLabel ?? label;
        return describeStage("上传", name, upload.totalBytes);
    }),
];

const formatBytes = (bytes) => {
    const mb = bytes / (1024 * 1024);
    if (mb < 1024) {
        return `${Math.round(mb).toLocaleString("zh-CN")} MB`;
    }
    const gb = mb / 1024;
    return `${gb.toLocaleString("zh-CN", { maximumFractionDigits: 2 })} GB`;
};

const configureTestPlan = () => {
    activeTestCases = getTestCases();
    stageDescriptions = getStageDescriptions(activeTestCases);
    totalStages = stageDescriptions.length;
    totalTransferBytes = activeTestCases.reduce((sum, testCase) => (
        sum + testCase.download.totalBytes + testCase.upload.totalBytes
    ), 0);
    totalProgressUnits = 1 + totalTransferBytes;
};

const updateModeCopy = () => {
    const multiplier = getTrafficMultiplier();
    const cases = getTestCases();
    const downloadBytes = cases.reduce((sum, testCase) => sum + testCase.download.totalBytes, 0);
    const uploadBytes = cases.reduce((sum, testCase) => sum + testCase.upload.totalBytes, 0);
    if (trafficSummaryEl) {
        trafficSummaryEl.textContent = `单次测速将产生约 ${formatBytes(downloadBytes)} 下载 + ${formatBytes(uploadBytes)} 上传流量。`;
    }
    if (progressHint && !startBtn?.disabled) {
        progressHint.textContent = multiplier > 1
            ? "高速网络模式已开启，点击启动大流量测速"
            : "点击启动全流程带宽测试";
    }
};

const clamp01 = (value) => Math.min(Math.max(value, 0), 1);

const updateProgressState = (state, options = {}) => {
    if (!progressFill || !progressLabel || !progressHint || !startBtn) {
        return;
    }

    if (state === "idle") {
        progressFill.style.width = "0%";
        progressLabel.textContent = "开始测速";
        progressHint.textContent = "点击启动全流程带宽测试";
        startBtn.classList.remove("is-active", "is-error");
        return;
    }

    const completed = options.completed ?? completedStages;
    const nextStage = options.nextStage ?? stageDescriptions[Math.min(completed, totalStages - 1)] ?? "收尾中";
    const fraction = clamp01(options.fraction ?? (
        totalProgressUnits === 0 ? 1 : completedProgressUnits / totalProgressUnits
    ));

    if (state === "running") {
        const width = completedProgressUnits === 0 ? 8 : Math.min(99, Math.max(5, fraction * 100));
        progressFill.style.width = `${width}%`;
        const percent = completedProgressUnits === 0 ? 5 : Math.min(99, Math.max(5, Math.round(fraction * 100)));
        progressLabel.textContent = `测速进行中 · ${percent}%`;
        progressHint.textContent = `阶段 ${Math.min(completed + 1, totalStages)}/${totalStages || 1} · ${nextStage}`;
        startBtn.classList.add("is-active");
        startBtn.classList.remove("is-error");
        return;
    }

    if (state === "completed") {
        progressFill.style.width = "100%";
        progressLabel.textContent = "测速完成";
        progressHint.textContent = "点击重新开始以再次测试";
        startBtn.classList.add("is-active");
        startBtn.classList.remove("is-error");
        return;
    }

    if (state === "error") {
        const width = completedProgressUnits === 0 ? 8 : Math.min(99, Math.max(5, fraction * 100));
        progressFill.style.width = `${width}%`;
        progressLabel.textContent = "测速失败";
        progressHint.textContent = options.message ?? "请检查网络连接后重试";
        startBtn.classList.add("is-active");
        startBtn.classList.add("is-error");
    }
};

const announceStageStart = () => {
    updateProgressState("running", {
        completed: completedStages,
        nextStage: stageDescriptions[Math.min(completedStages, totalStages - 1)],
    });
};

const markStageComplete = (progressUnits = 0) => {
    completedStages = Math.min(completedStages + 1, totalStages);
    completedProgressUnits = Math.min(totalProgressUnits, completedProgressUnits + progressUnits);
    const nextStage = completedStages >= totalStages ? undefined : stageDescriptions[completedStages];
    updateProgressState("running", {
        completed: completedStages,
        nextStage,
    });
};

const resetProgress = () => {
    completedStages = 0;
    completedProgressUnits = 0;
    updateProgressState("idle");
};

const recordTransferProgress = (bytes) => {
    completedProgressUnits = Math.min(totalProgressUnits, completedProgressUnits + Math.max(0, bytes));
    const now = performance.now();
    if (now - lastProgressRender < 100) return;
    lastProgressRender = now;
    updateProgressState("running", {
        completed: completedStages,
        nextStage: stageDescriptions[Math.min(completedStages, totalStages - 1)],
    });
};

const formatNumber = (value, fractionDigits = 2) => {
    if (!Number.isFinite(value) || value <= 0) {
        return "-";
    }
    return value.toFixed(fractionDigits);
};

const setStatus = (message) => {
    statusEl.textContent = `状态：${message}${runNode ? ` · ${runNode.name}` : ""}`;
};

const updateMetric = (element, value) => {
    element.textContent = formatNumber(value);
};

const initializeCaseTable = () => {
    if (!caseResultsBody || caseRows.size > 0) {
        return;
    }

    BASE_TEST_CASES.forEach((testCase) => {
        const row = document.createElement("tr");
        const sizeCell = document.createElement("td");
        sizeCell.textContent = testCase.displayLabel ?? testCase.label;

        const downloadCell = document.createElement("td");
        downloadCell.textContent = "-";

        const uploadCell = document.createElement("td");
        uploadCell.textContent = "-";
        for (const cell of [downloadCell, uploadCell]) {
            const time = document.createElement("small");
            time.className = "case-request-time";
            cell.appendChild(time);
        }

        row.append(sizeCell, downloadCell, uploadCell);
        caseResultsBody.appendChild(row);
        caseRows.set(testCase.key, { downloadCell, uploadCell });
    });
};

const setCaseResult = (key, type, value, summary) => {
    const row = caseRows.get(key);
    if (!row) {
        return;
    }
    const targetCell = type === "download" ? row.downloadCell : row.uploadCell;
    targetCell.textContent = formatNumber(value);
    const time = document.createElement("small");
    time.className = "case-request-time";
    time.textContent = summary ? `平均 ${summary.averageMs.toFixed(1)} ms / 资源（${summary.requestCount} 次）` : "";
    targetCell.appendChild(time);
};

const resetCaseResults = () => {
    BASE_TEST_CASES.forEach(({ key }) => {
        setCaseResult(key, "download", NaN);
        setCaseResult(key, "upload", NaN);
    });
};

const measureLatency = async () => {
    const attempts = 3;
    let total = 0;
    for (let i = 0; i < attempts; i++) {
        const start = performance.now();
        await withTimedFetch(testEndpoint(`/speedtest/ping?ts=${Date.now()}`), (response) => response.json(), 10_000);
        total += performance.now() - start;
    }
    return total / attempts;
};

const runResourceRequests = async (resourceBytes, totalBytes, request, onSummary) => {
    const resourceSize = Math.max(1, Math.floor(resourceBytes));
    const targetBytes = Math.max(1, Math.floor(totalBytes));
    let transferred = 0;
    let requestCount = 0;
    let requestMs = 0;
    const start = performance.now();
    while (transferred < targetBytes) {
        if (cancelled) throw new Error("请求已取消或超时");
        const size = Math.min(resourceSize, targetBytes - transferred);
        const requestStart = performance.now();
        const actualBytes = await request(size);
        if (cancelled) throw new Error("请求已取消或超时");
        requestMs += performance.now() - requestStart;
        transferred += actualBytes;
        requestCount++;
    }
    const durationSec = (performance.now() - start) / 1000;
    onSummary?.({ requestCount, averageMs: requestMs / requestCount });
    return durationSec <= 0 ? NaN : (transferred * 8) / durationSec / 1_000_000;
};

const runDownloadTest = (resourceBytes, totalBytes, onProgress, onSummary) => runResourceRequests(
    resourceBytes, totalBytes, async (size) => {
        let receivedTotal = 0;
        await withTimedFetch(testEndpoint(`/speedtest/download?bytes=${size}&request=${Date.now()}-${++requestSequence}`), async (response) => {
            if (response.body && response.body.getReader) {
                const reader = response.body.getReader();
                try {
                    while (true) {
                        if (cancelled) throw new Error("请求已取消或超时");
                        const { value, done } = await reader.read();
                        if (done) break;
                        receivedTotal += value.length;
                        onProgress?.(value.length);
                    }
                } finally {
                    reader.releaseLock();
                }
            } else {
                const buffer = await response.arrayBuffer();
                receivedTotal += buffer.byteLength;
                onProgress?.(buffer.byteLength);
            }
        });
        if (receivedTotal !== size) throw new Error("下载数据不完整");
        return receivedTotal;
    }, onSummary,
);

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

const getUploadPayload = (resourceBytes) => {
    const resourceSize = Math.max(1, Math.floor(resourceBytes));
    const cached = uploadPayloadCache.get(resourceSize);
    if (cached) {
        return cached;
    }

    const payload = new Uint8Array(resourceSize);
    fillRandomBytes(payload);
    const blob = new Blob([payload], { type: "application/octet-stream" });
    uploadPayloadCache.set(resourceSize, blob);
    return blob;
};

const prepareUploadPayloads = (testCases) => {
    for (const testCase of testCases) {
        getUploadPayload(testCase.upload.resourceBytes);
    }
};

const uploadResource = (body, onProgress) => {
    return new Promise((resolve, reject) => {
        if (cancelled) { reject(new Error("上传测试已取消")); return; }
        const xhr = new XMLHttpRequest();
        activeXHR = xhr;
        let reportedBytes = 0;

        xhr.open("POST", testEndpoint("/speedtest/upload"), true);
        xhr.timeout = REQUEST_TIMEOUT_MS;
        xhr.withCredentials = false;
        xhr.onloadend = () => { if (activeXHR === xhr) activeXHR = null; };
        xhr.setRequestHeader("Content-Type", "application/octet-stream");
        xhr.responseType = "json";
        xhr.upload.onprogress = (event) => {
            if (!event.lengthComputable) {
                return;
            }
            const delta = Math.max(0, event.loaded - reportedBytes);
            reportedBytes = event.loaded;
            onProgress?.(delta);
        };
        xhr.onload = () => {
            if (xhr.status < 200 || xhr.status >= 300) {
                reject(new Error("上传测试请求失败"));
                return;
            }

            const uploadedTotal = xhr.response?.receivedBytes;
            if (uploadedTotal !== body.size) {
                reject(new Error("上传响应无效或数据不完整"));
                return;
            }
            if (reportedBytes < uploadedTotal) {
                onProgress?.(uploadedTotal - reportedBytes);
            }

            resolve(uploadedTotal);
        };
        xhr.onerror = () => reject(new Error("上传测试请求失败"));
        xhr.ontimeout = () => reject(new Error("上传测试请求超时"));
        xhr.onabort = () => reject(new Error("上传测试已取消"));
        xhr.send(body);
    });
};

const runUploadTest = (resourceBytes, totalBytes, onProgress, onSummary) => {
    const payload = getUploadPayload(resourceBytes);
    return runResourceRequests(resourceBytes, totalBytes,
        (size) => uploadResource(size === payload.size ? payload : payload.slice(0, size), onProgress), onSummary);
};

initializeCaseTable();
configureTestPlan();
resetProgress();
updateModeCopy();

startBtn.disabled = true;
const nodePicker = window.TestNodes.create({
    capability: "speedtest",
    select: document.getElementById("testNode"),
    probeButton: document.getElementById("probe-nodes"),
    status: document.getElementById("node-status"),
    onChange: (node) => { startBtn.disabled = !!runNode || !node; },
});

highSpeedModeEl?.addEventListener("change", () => {
    if (runNode) return;
    configureTestPlan();
    resetProgress();
    updateModeCopy();
});

startBtn.addEventListener("click", async () => {
    if (startBtn.disabled || runNode || !nodePicker.selected) {
        return;
    }
    startBtn.blur();
    cancelled = false;
    lastProgressRender = 0;
    runNode = Object.freeze({ ...nodePicker.selected });
    nodePicker.setLocked(true);
    startBtn.disabled = true;
    document.getElementById("cancel-test").hidden = false;
    if (highSpeedModeEl) {
        highSpeedModeEl.disabled = true;
    }
    configureTestPlan();
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
        markStageComplete(1);

        setStatus("准备上传测试数据...");
        prepareUploadPayloads(activeTestCases);

        const downloadResults = new Map();
        for (const testCase of activeTestCases) {
            announceStageStart();
            const label = testCase.displayLabel ?? testCase.label;
            setStatus(`测试下载速度（${label}）...`);
            const { resourceBytes, totalBytes } = testCase.download;
            let summary;
            const downloadMbps = await runDownloadTest(resourceBytes, totalBytes, recordTransferProgress, (value) => { summary = value; });
            downloadResults.set(testCase.key, downloadMbps);
            setCaseResult(testCase.key, "download", downloadMbps, summary);
            markStageComplete();
        }

        const uploadResults = new Map();
        for (const testCase of activeTestCases) {
            announceStageStart();
            const label = testCase.displayLabel ?? testCase.label;
            setStatus(`测试上传速度（${label}）...`);
            const { resourceBytes, totalBytes } = testCase.upload;
            let summary;
            const uploadMbps = await runUploadTest(resourceBytes, totalBytes, recordTransferProgress, (value) => { summary = value; });
            uploadResults.set(testCase.key, uploadMbps);
            setCaseResult(testCase.key, "upload", uploadMbps, summary);
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
        cancelRequests();
        uploadPayloadCache.clear();
        document.getElementById("cancel-test").hidden = true;
        runNode = null;
        nodePicker.setLocked(false);
        startBtn.disabled = !nodePicker.selected;
        if (highSpeedModeEl) {
            highSpeedModeEl.disabled = false;
        }
    }
});
