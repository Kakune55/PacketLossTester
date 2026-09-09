const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

function setup() {
    const elements = new Map();
    const element = () => ({ style: {}, classList: { add() {}, remove() {} }, addEventListener() {}, append() {}, appendChild() {} });
    let xhr;
    class XHR {
        constructor() { xhr = this; this.upload = {}; }
        open() {}
        setRequestHeader() {}
        send(body) { this.body = body; }
        abort() { this.onabort(); this.onloadend(); }
    }
    const context = vm.createContext({
        Blob, AbortController, Uint8Array, XMLHttpRequest: XHR,
        setTimeout, clearTimeout, performance, console,
        window: { addEventListener() {} },
        document: {
            getElementById(id) {
                if (!elements.has(id)) elements.set(id, element());
                return elements.get(id);
            },
            createElement: element,
        },
    });
    vm.runInContext(readFileSync(require('node:path').join(__dirname, '../static/js/speedtest.js'), 'utf8'), context);
    return { context, run: (code) => vm.runInContext(code, context), xhr: () => xhr };
}

test('XHR Blob exact size, timeout, and validated server byte count', async () => {
    const s = setup();
    const promise = s.run('runUploadTest(3, 10)');
    const xhr = s.xhr();
    assert.equal(xhr.body.size, 10);
    assert.equal(xhr.timeout, 125000);
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
