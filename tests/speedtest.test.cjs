const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

function setup() {
    const elements = new Map();
    const element = () => ({ style: {}, classList: { add() {}, remove() {} }, listeners: {}, children: [],
        set textContent(value) { this.text = value; this.children = []; },
        get textContent() { return this.text; },
        addEventListener(event, fn) { this.listeners[event] = fn; },
        append(...children) { this.children.push(...children); },
        appendChild(child) { this.children.push(child); }, blur() {} });
    const picker = {
        selected: { id: 'a', name: '节点 A', baseUrl: 'https://node.example.test/edge' },
        setLocked(locked) { this.locked = locked; },
    };
    let xhr;
    const xhrs = [];
    const windowListeners = {};
    class XHR {
        constructor() { xhr = this; xhrs.push(this); this.upload = {}; }
        open(method, url) { this.method = method; this.url = url; }
        setRequestHeader() {}
        send(body) { this.body = body; }
        abort() { this.onabort(); this.onloadend(); }
    }
    const context = vm.createContext({
        Blob, AbortController, Uint8Array, XMLHttpRequest: XHR,
        setTimeout, clearTimeout, performance, console,
        window: { crypto: require('node:crypto').webcrypto,
            addEventListener(event, fn) { windowListeners[event] = fn; }, TestNodes: {
            create({ onChange }) { onChange(picker.selected); return picker; },
            endpoint(node, path) { return `${node.baseUrl}${path}`; },
        } },
        document: {
            getElementById(id) {
                if (!elements.has(id)) elements.set(id, element());
                return elements.get(id);
            },
            createElement: element,
        },
    });
    vm.runInContext(readFileSync(require('node:path').join(__dirname, '../static/js/speedtest.js'), 'utf8'), context);
    return { context, picker, elements, xhrs, windowListeners,
        run: (code) => vm.runInContext(code, context), xhr: () => xhr };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const finishUpload = (xhr, bytes = xhr.body.size) => {
    xhr.status = 200; xhr.response = { receivedBytes: bytes };
    xhr.onload(); xhr.onloadend();
};

test('XHR serial resource sizes, reuse, timing, progress and server byte count', async () => {
    const s = setup();
    let now = 0;
    s.context.performance = { now: () => now };
    const progress = [];
    let summary;
    s.context.progress = (bytes) => progress.push(bytes);
    s.context.summary = (value) => { summary = value; };
    const promise = s.run('runUploadTest(3, 10, progress, summary)');
    for (const [index, size] of [3, 3, 3, 1].entries()) {
        assert.equal(s.xhrs.length, index + 1);
        const xhr = s.xhr();
        assert.equal(xhr.body.size, size);
        assert.equal(xhr.timeout, 125000);
        assert.equal(xhr.withCredentials, false);
        assert.equal(xhr.url, 'https://node.example.test/edge/speedtest/upload');
        xhr.upload.onprogress({ lengthComputable: true, loaded: 1 });
        now += 25;
        finishUpload(xhr);
        await flush();
    }
    assert.equal(await promise, 0.0008);
    assert.equal(summary.requestCount, 4);
    assert.equal(summary.averageMs, 25);
    assert.equal(progress.reduce((a, b) => a + b, 0), 10);
    assert.equal(s.xhrs[0].body, s.xhrs[1].body);
    assert.equal(s.run('uploadPayloadCache.size'), 1);
    assert.equal(s.run('getUploadPayload(3).size'), 3);
    assert.equal(s.run('activeXHR'), null);
});

test('XHR malformed response, timeout, network error, and cancellation settle', async () => {
    for (const event of ['onload', 'ontimeout', 'onerror', 'abort']) {
        const s = setup();
        const promise = s.run('runUploadTest(3, 10)');
        s.xhr().status = 200;
        s.xhr().response = null;
        s.xhr()[event]();
        await assert.rejects(promise);
    }
});

test('fetch deadline includes response body and supports cancellation', async () => {
    for (const cancel of [false, true]) {
        const s = setup();
        s.context.fetch = async (_url, { signal }) => ({
            ok: true,
            json: () => new Promise((_resolve, reject) => {
                if (signal.aborted) { reject(new Error('aborted')); return; }
                signal.addEventListener('abort', () => reject(new Error('aborted')));
            }),
        });
        const promise = s.run('withTimedFetch("/ping", r => r.json(), 20)');
        if (cancel) {
            await Promise.resolve();
            s.run('cancelRequests()');
        }
        await assert.rejects(promise, /取消或超时/);
        assert.equal(s.run('activeController'), null);
    }
});

test('download checks final byte count and progress accounting is unthrottled', async () => {
    const s = setup();
    s.context.fetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) });
    await assert.rejects(s.run('runDownloadTest(1, 5)'), /不完整/);
    s.run('completedProgressUnits = 0; for (let i = 0; i < 100; i++) recordTransferProgress(1)');
    assert.equal(s.run('completedProgressUnits'), 100);
});

test('progress rendering stays throttled to 100ms without losing byte accounting', () => {
    const s = setup();
    let now = 99;
    s.context.performance = { now: () => now };
    s.run('recordTransferProgress(5)');
    assert.equal(s.run('lastProgressRender'), 0);
    now = 100;
    s.run('recordTransferProgress(7)');
    assert.equal(s.run('lastProgressRender'), 100);
    now = 199;
    s.run('recordTransferProgress(11)');
    assert.equal(s.run('lastProgressRender'), 100);
    now = 200;
    s.run('recordTransferProgress(13)');
    assert.equal(s.run('lastProgressRender'), 200);
    assert.equal(s.run('completedProgressUnits'), 36);
});

test('download uses the selected node with no cross-origin credentials', async () => {
    const s = setup();
    let request;
    s.context.fetch = async (url, options) => {
        request = { url, options };
        return { ok: true, arrayBuffer: async () => new ArrayBuffer(4) };
    };
    await s.run('runDownloadTest(65536, 4)');
    assert.match(request.url, /^https:\/\/node\.example\.test\/edge\/speedtest\/download\?bytes=4&request=/);
    assert.equal(request.options.credentials, 'omit');
    assert.equal(request.options.cache, 'no-store');
});

test('plans use exact whole resources and high speed multiplies counts only', () => {
    const s = setup();
    const normal = s.run('getTestCases()');
    s.elements.get('high-speed-mode').checked = true;
    const high = s.run('getTestCases()');
    for (const [i, count] of [308, 62, 30, 3, 1].entries()) {
        for (const direction of ['download', 'upload']) {
            assert.equal(normal[i][direction].count, count);
            assert.equal(normal[i][direction].totalBytes, count * normal[i][direction].resourceBytes);
            assert.equal(high[i][direction].count, count * 10);
            assert.equal(high[i][direction].resourceBytes, normal[i][direction].resourceBytes);
            assert.equal(high[i][direction].totalBytes, normal[i][direction].totalBytes * 10);
        }
    }
    assert.equal(normal[4].download.resourceBytes, 100 * 1024 * 1024);
    assert.equal(normal[4].upload.resourceBytes, 30 * 1024 * 1024);
    s.run('prepareUploadPayloads(getTestCases())');
    assert.deepEqual(Array.from(s.run('[...uploadPayloadCache.values()].map(blob => blob.size)')),
        [100 * 1024, 500 * 1024, 1024 * 1024, 10 * 1024 * 1024, 30 * 1024 * 1024]);
});

test('download waits for full bodies, uses unique independent GETs and aggregates timing', async () => {
    const s = setup();
    let now = 0;
    s.context.performance = { now: () => now };
    const requests = [];
    const progress = [];
    let summary;
    let finishBody;
    s.context.progress = (bytes) => progress.push(bytes);
    s.context.summary = (value) => { summary = value; };
    s.run('runNode = Object.freeze({ ...nodePicker.selected })');
    s.context.fetch = async (url, options) => {
        requests.push({ url, options });
        return { ok: true, arrayBuffer: () => new Promise((resolve) => {
            finishBody = () => { now += 40; resolve(new ArrayBuffer(Number(new URL(url).searchParams.get('bytes')))); };
        }) };
    };
    const promise = s.run('runDownloadTest(3, 8, progress, summary)');
    for (let i = 0; i < 3; i++) {
        await flush();
        assert.equal(requests.length, i + 1);
        s.picker.selected = { baseUrl: 'https://other.test' };
        finishBody();
    }
    assert.equal(await promise, 64 / 0.12 / 1_000_000);
    assert.equal(summary.requestCount, 3);
    assert.equal(summary.averageMs, 40);
    assert.deepEqual(progress, [3, 3, 2]);
    assert.equal(new Set(requests.map(({ url }) => url)).size, 3);
    for (const { url, options } of requests) {
        assert.match(url, /^https:\/\/node\.example\.test\/edge\//);
        assert.equal(new URL(url).searchParams.has('chunk'), false);
        assert.equal(options.credentials, 'omit');
        assert.equal(options.cache, 'no-store');
    }
});

test('second resource failure or cancellation prevents subsequent downloads', async () => {
    for (const mode of ['http', 'short', 'cancel', 'pagehide']) {
        const s = setup();
        let requests = 0;
        s.context.fetch = async (_url, { signal }) => {
            requests++;
            if (requests === 1) return { ok: true, arrayBuffer: async () => new ArrayBuffer(3) };
            if (mode === 'http') return { ok: false, status: 503 };
            if (mode === 'short') return { ok: true, arrayBuffer: async () => new ArrayBuffer(2) };
            return { ok: true, arrayBuffer: () => new Promise((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(new Error('aborted')));
                if (mode === 'pagehide') s.windowListeners.pagehide();
                else s.run('cancelRequests()');
            }) };
        };
        await assert.rejects(s.run('runDownloadTest(3, 9)'));
        assert.equal(requests, 2);
    }
});

test('second upload failure or cancellation prevents subsequent resources', async () => {
    for (const mode of ['invalid', 'cancel', 'between']) {
        const s = setup();
        const promise = s.run('runUploadTest(3, 12)');
        const rejection = assert.rejects(promise);
        finishUpload(s.xhr());
        await flush();
        assert.equal(s.xhrs.length, 2);
        if (mode === 'invalid') finishUpload(s.xhr(), 2);
        else if (mode === 'cancel') s.run('cancelRequests()');
        else { finishUpload(s.xhr()); s.run('cancelRequests()'); }
        await rejection;
        assert.equal(s.xhrs.length, 2);
    }
});

test('streamed download progress spans resources and cancellation between resources is sticky', async () => {
    const s = setup();
    let requests = 0;
    let released = 0;
    s.context.fetch = async () => {
        requests++;
        let reads = 0;
        return { ok: true, body: { getReader: () => ({
            read: async () => ++reads <= 2 ? { value: new Uint8Array(2), done: false } : { done: true },
            releaseLock() { released++; },
        }) } };
    };
    const progress = [];
    s.context.progress = (bytes) => progress.push(bytes);
    await s.run('runDownloadTest(4, 8, progress)');
    assert.deepEqual(progress, [2, 2, 2, 2]);
    assert.equal(released, 2);
    s.context.progress = () => s.run('cancelRequests()');
    await assert.rejects(s.run('runDownloadTest(4, 8, progress)'));
    assert.equal(requests, 3);
    await assert.rejects(s.run('runDownloadTest(4, 8)'));
    assert.equal(requests, 3);
});

test('case cells retain Mbps and reset clears the per-resource summary', () => {
    const s = setup();
    s.run('setCaseResult("100kb", "download", 12.345, { requestCount: 308, averageMs: 4.25 })');
    const cell = s.run('caseRows.get("100kb").downloadCell');
    assert.equal(cell.textContent, '12.35');
    assert.equal(cell.children[0].className, 'case-request-time');
    assert.match(cell.children[0].textContent, /4.3 ms.*308/);
    s.run('resetCaseResults()');
    assert.equal(cell.textContent, '-');
    assert.equal(cell.children.length, 1);
    assert.equal(cell.children[0].textContent, '');
});

test('a running speed test freezes its node and unlocks after cancellation', async () => {
    const s = setup();
    s.context.console = { ...console, error() {} };
    const requests = [];
    let bodyStarted;
    const consuming = new Promise((resolve) => { bodyStarted = resolve; });
    s.context.fetch = async (url, { signal }) => {
        requests.push(url);
        return { ok: true, json: () => new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')));
            bodyStarted();
        }) };
    };
    const running = s.elements.get('start-test').listeners.click();
    assert.equal(s.picker.locked, true);
    assert.equal(s.elements.get('high-speed-mode').disabled, true);
    s.picker.selected = { id: 'b', name: '节点 B', baseUrl: 'https://other.test' };
    assert.match(requests[0], /^https:\/\/node\.example\.test\/edge\/speedtest\/ping/);
    assert.equal(s.run('testEndpoint("/speedtest/upload")'), 'https://node.example.test/edge/speedtest/upload');
    await consuming;
    s.run('cancelRequests()');
    await running;
    assert.equal(s.picker.locked, false);
    assert.equal(s.elements.get('start-test').disabled, false);
    assert.equal(s.elements.get('high-speed-mode').disabled, false);
    assert.match(s.elements.get('status').textContent, /请求已取消或超时.*节点 A/);
    const restarted = s.elements.get('start-test').listeners.click();
    assert.equal(s.run('cancelled'), false);
    await flush();
    s.run('cancelRequests()');
    await restarted;
    assert.equal(requests.length, 2);
});
