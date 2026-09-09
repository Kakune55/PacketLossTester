const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

function setup() {
    const elements = new Map();
    const element = () => ({ style: {}, classList: { add() {}, remove() {} }, listeners: {},
        addEventListener(event, fn) { this.listeners[event] = fn; }, append() {}, appendChild() {}, blur() {} });
    const picker = {
        selected: { id: 'a', name: '节点 A', baseUrl: 'https://node.example.test/edge' },
        setLocked(locked) { this.locked = locked; },
    };
    let xhr;
    class XHR {
        constructor() { xhr = this; this.upload = {}; }
        open(method, url) { this.method = method; this.url = url; }
        setRequestHeader() {}
        send(body) { this.body = body; }
        abort() { this.onabort(); this.onloadend(); }
    }
    const context = vm.createContext({
        Blob, AbortController, Uint8Array, XMLHttpRequest: XHR,
        setTimeout, clearTimeout, performance, console,
        window: { addEventListener() {}, TestNodes: {
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
    return { context, picker, elements, run: (code) => vm.runInContext(code, context), xhr: () => xhr };
}

test('XHR Blob exact size, timeout, and validated server byte count', async () => {
    const s = setup();
    const promise = s.run('runUploadTest(3, 10)');
    const xhr = s.xhr();
    assert.equal(xhr.body.size, 10);
    assert.equal(xhr.timeout, 125000);
    assert.equal(xhr.url, 'https://node.example.test/edge/speedtest/upload');
    xhr.status = 200; xhr.response = { receivedBytes: 10 };
    xhr.onload(); xhr.onloadend();
    assert.ok(Number.isFinite(await promise));
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

test('download uses the selected node with no cross-origin credentials', async () => {
    const s = setup();
    let request;
    s.context.fetch = async (url, options) => {
        request = { url, options };
        return { ok: true, arrayBuffer: async () => new ArrayBuffer(4) };
    };
    await s.run('runDownloadTest(65536, 4)');
    assert.equal(request.url, 'https://node.example.test/edge/speedtest/download?bytes=4&chunk=65536');
    assert.equal(request.options.credentials, 'omit');
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
    s.picker.selected = { id: 'b', name: '节点 B', baseUrl: 'https://other.test' };
    assert.match(requests[0], /^https:\/\/node\.example\.test\/edge\/speedtest\/ping/);
    assert.equal(s.run('testEndpoint("/speedtest/upload")'), 'https://node.example.test/edge/speedtest/upload');
    await consuming;
    s.run('cancelRequests()');
    await running;
    assert.equal(s.picker.locked, false);
    assert.equal(s.elements.get('start-test').disabled, false);
    assert.match(s.elements.get('status').textContent, /请求已取消或超时.*节点 A/);
});
