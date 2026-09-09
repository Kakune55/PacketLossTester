const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const api = require('../static/js/measurement.js');

function harness() {
    let now = 0;
    let nextId = 0;
    const timers = new Map();
    const elements = new Map();
    const sockets = [];
    const peers = [];
    const canvas = new Proxy({}, { get: (_, key) => key === 'measureText' ? () => ({ width: 20 }) : () => {} });
    function element(id) {
        if (!elements.has(id)) elements.set(id, {
            value: '1', min: '1', max: '300', style: {}, checked: false,
            listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; },
            closest: () => ({ classList: { toggle() {} } }),
            replaceChildren() {}, getContext: () => canvas,
            getBoundingClientRect: () => ({ width: 600, height: 300 }),
        });
        return elements.get(id);
    }
    element('testNode').value = 'wss://example.test/ws';
    element('frequency').max = element('frequency-input').max = '256';
    element('size').max = element('size-input').max = '16384';
    class WebSocket {
        static OPEN = 1;
        constructor() { this.readyState = 1; this.sent = []; sockets.push(this); }
        send(value) { this.sent.push(value); }
        close() { this.closed = true; }
    }
    class RTCPeerConnection {
        constructor() { peers.push(this); }
        createDataChannel() {
            this.channel = {
                readyState: 'open', bufferedAmount: 0, sent: [],
                send(value) { this.sent.push(value); }, close() { this.closed = true; },
            };
            return this.channel;
        }
        async createOffer() { return { type: 'offer', sdp: 'test' }; }
        async setLocalDescription(value) { this.localDescription = value; }
        async setRemoteDescription(value) { this.remoteDescription = value; }
        async addIceCandidate(value) {
            if (!this.remoteDescription) throw new Error('missing remote description');
            (this.candidates ??= []).push(value);
        }
        close() { this.closed = true; }
    }
    const addTimer = (fn, ms, repeat = false) => {
        const id = ++nextId;
        timers.set(id, { fn, ms, due: now + ms, repeat });
        return id;
    };
    const context = {
        document: { getElementById: element, createElement: () => ({}), documentElement: {} },
        PacketMeasurement: api, WebSocket, RTCPeerConnection,
        RTCSessionDescription: function (value) { return value; },
        RTCIceCandidate: function (value) { return value; },
        performance: { now: () => now }, console,
        getComputedStyle: () => ({ getPropertyValue: () => '' }),
        fetch: () => new Promise(() => {}),
        setInterval: (fn, ms) => addTimer(fn, ms, true),
        setTimeout: (fn, ms) => addTimer(fn, ms),
        clearTimeout: (id) => timers.delete(id), clearInterval: (id) => timers.delete(id),
        requestAnimationFrame: (fn) => addTimer(() => fn(now), 16),
        cancelAnimationFrame: (id) => timers.delete(id),
    };
    context.window = context;
    vm.runInNewContext(fs.readFileSync(`${__dirname}/../static/js/app.js`, 'utf8'), context);
    return {
        element, sockets, peers,
        click: (id) => element(id).listeners.click(),
        async connect(bufferedAmount = 0) {
            await this.click('start-btn');
            await sockets.at(-1).onopen();
            peers.at(-1).channel.bufferedAmount = bufferedAmount;
            peers.at(-1).channel.onopen();
            return peers.at(-1).channel;
        },
        tick(ms) {
            const target = now + ms;
            for (;;) {
                let selected;
                for (const entry of timers) {
                    if (entry[1].due <= target && (!selected || entry[1].due < selected[1].due)) selected = entry;
                }
                if (!selected) break;
                const [id, timer] = selected;
                now = timer.due;
                if (timer.repeat) timer.due += timer.ms; else timers.delete(id);
                timer.fn();
            }
            now = target;
        },
    };
}

test('app drains before closing, accepts final reply, locks controls and restores stress duration', async () => {
    const h = harness();
    const channel = await h.connect();
    assert.equal(h.element('stress-mode').disabled, true);
    assert.equal(h.element('frequency-input').disabled, true);
    h.tick(1000);
    assert.equal(channel.sent.length, 1);
    assert.equal(channel.closed, undefined);
    assert.equal(h.element('start-btn').disabled, true);
    assert.equal(h.element('pending-packets').innerText, 1);
    channel.onmessage({ data: channel.sent[0] });
    assert.equal(channel.closed, true);
    assert.equal(h.element('packet-loss-rate').innerText, '0.00%');
    assert.equal(h.element('frequency-input').disabled, false);
    h.element('stress-mode').checked = true;
    await h.connect();
    h.click('stop-btn');
    assert.equal(h.element('duration').disabled, true);
});

test('app settles zero replies to 100% without a receive event', async () => {
    const h = harness();
    const channel = await h.connect();
    h.tick(1000);
    assert.equal(h.element('packet-loss-rate').innerText, '-');
    h.tick(3000);
    assert.equal(channel.closed, true);
    assert.equal(h.element('packet-loss-rate').innerText, '100.00%');
    assert.equal(h.element('pending-packets').innerText, 0);
});

test('old channel callbacks and rejected offer cannot stop a new run', async () => {
    const h = harness();
    await h.click('start-btn');
    let rejectOffer;
    const opening = h.sockets[0].onopen();
    await opening;
    const oldMessage = h.peers[0].channel.onmessage;
    const oldClose = h.sockets[0].onclose;
    h.click('stop-btn');
    await h.click('start-btn');
    // Hold this run inside createOffer, then replace it while the promise is pending.
    h.peers[0].constructor.prototype.createOffer = () => new Promise((_, reject) => { rejectOffer = reject; });
    const pendingOpen = h.sockets[1].onopen();
    h.click('stop-btn');
    await h.click('start-btn');
    const status = h.element('status').innerText;
    oldMessage({ data: '0,0' });
    oldClose();
    rejectOffer(new Error('stale offer'));
    await pendingOpen;
    assert.equal(h.element('status').innerText, status);
    assert.equal(h.element('start-btn').disabled, true);
    assert.equal(h.sockets[2].closed, undefined);
});

test('buffer cap reports local overload without counting an unsent packet', async () => {
    const h = harness();
    const channel = await h.connect(api.MAX_BUFFERED_BYTES);
    h.tick(1000);
    assert.equal(channel.sent.length, 0);
    assert.match(h.element('status').innerText, /积压超过 1 MiB/);
    assert.equal(h.element('sent-packets').innerText, 0);
    assert.equal(h.element('packet-loss-rate').innerText, '-');
});

test('one packet per second starts immediately rather than racing the stop timer', async () => {
    const h = harness();
    const channel = await h.connect();
    assert.equal(channel.sent.length, 1);
    channel.onmessage({ data: channel.sent[0] });
    h.tick(1000);
    assert.equal(channel.sent.length, 1);
    assert.equal(channel.closed, true);
    assert.equal(h.element('packet-loss-rate').innerText, '0.00%');
});

test('connection timeout unlocks configuration and closes the connection', async () => {
    const h = harness();
    await h.click('start-btn');
    h.tick(15000);
    assert.match(h.element('status').innerText, /连接超时/);
    assert.equal(h.element('testNode').disabled, false);
    assert.equal(h.sockets[0].closed, true);
});

test('run uses captured frequency, size, duration and mode despite DOM changes', async () => {
    const h = harness();
    h.element('duration-input').value = '3';
    h.element('size-input').value = '64';
    const channel = await h.connect();
    h.element('frequency-input').value = '256';
    h.element('size-input').value = '8192';
    h.element('duration-input').value = '300';
    h.element('stress-mode').checked = true;
    h.element('stress-mode').listeners.change();
    h.tick(3000);
    assert.equal(channel.sent.length, 3);
    assert.ok(channel.sent.every((packet) => packet.length === 64));
    assert.equal(h.element('stop-btn').disabled, true);
    h.tick(3000);
    assert.equal(channel.closed, true);
});

test('channel closing during drain remains an abnormal result', async () => {
    const h = harness();
    const channel = await h.connect();
    h.tick(1000);
    channel.onclose();
    h.tick(3000);
    assert.match(h.element('status').innerText, /测试异常：数据通道关闭/);
    assert.equal(h.element('packet-loss-rate').innerText, '100.00%');
});

test('remote candidates arriving before SDP are queued until the answer is applied', async () => {
    const h = harness();
    await h.connect();
    const socket = h.sockets[0];
    const peer = h.peers[0];
    await socket.onmessage({ data: JSON.stringify({ candidate: 'candidate:test' }) });
    assert.equal(peer.candidates, undefined);
    await socket.onmessage({ data: JSON.stringify({ type: 'answer', sdp: 'test' }) });
    assert.equal(peer.candidates.length, 1);
    assert.equal(peer.candidates[0].candidate, 'candidate:test');
});
