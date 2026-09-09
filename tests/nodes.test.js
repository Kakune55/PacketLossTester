const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../static/js/nodes.js'), 'utf8');
const node = (id, baseUrl = '', capabilities = ['packetloss']) => ({ id, name: id, region: 'test', baseUrl, capabilities });
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

class Element {
    constructor() { this.children = []; this.attributes = {}; this.listeners = {}; this.value = ''; this.disabled = false; this.textContent = ''; }
    setAttribute(key, value) { this.attributes[key] = value; }
    getAttribute(key) { return this.attributes[key]; }
    appendChild(child) { this.children.push(child); }
    replaceChildren() { this.children = []; }
    addEventListener(event, callback) { this.listeners[event] = callback; }
    removeEventListener(event) { delete this.listeners[event]; }
    fire(event) { return this.listeners[event]?.(); }
}

function setup({ nodes = [node('local')], href = 'https://app.test/test?keep=1', stored, restricted = false, request, api } = {}) {
    const select = new Element();
    const probeButton = new Element();
    const status = new Element();
    const link = new Element();
    link.setAttribute('href', '/speed?other=2#details');
    const changes = [];
    const calls = [];
    const timers = new Map();
    let clock = 0;
    let timerID = 0;
    const storage = new Map(stored ? [['packetloss.node', stored]] : []);
    const window = {
        location: new URL(href),
        history: { replaceState(_state, _title, url) { window.location = new URL(url); } },
        localStorage: {
            getItem(key) { if (restricted) throw new Error('denied'); return storage.get(key); },
            setItem(key, value) { if (restricted) throw new Error('denied'); storage.set(key, value); },
        },
    };
    vm.runInNewContext(source, {
        window, document: { createElement: () => new Element(), querySelectorAll: () => [link] },
        URL, AbortController, performance: { now: () => clock },
        setTimeout(callback, delay) { const id = ++timerID; timers.set(id, { callback, at: clock + delay }); return id; },
        clearTimeout(id) { timers.delete(id); },
        fetch(url, options) {
            calls.push({ url, options });
            if (url === '/api/nodes') return api ? api(options) : Promise.resolve({ ok: true, json: async () => ({ nodes }) });
            return request ? request(url, options) : Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
        },
    });
    const picker = window.TestNodes.create({ capability: 'packetloss', select, probeButton, status, onChange: value => changes.push(value) });
    return { picker, window, select, probeButton, status, link, storage, changes, calls, timers,
        async tick(ms) {
            clock += ms;
            for (const [id, timer] of [...timers]) if (timer.at <= clock) { timers.delete(id); timer.callback(); }
            await flush();
        },
    };
}

test('endpoint preserves prefixes, maps protocols, and rejects unsafe base URLs', async () => {
    const env = setup();
    await env.picker.ready;
    const endpoint = env.window.TestNodes.endpoint;
    assert.equal(endpoint(node('a', 'https://remote.test/prefix/'), '/ws', true), 'wss://remote.test/prefix/ws');
    assert.equal(endpoint(node('a', 'http://remote.test/prefix'), '/speedtest/ping?nonce=x'), 'http://remote.test/prefix/speedtest/ping?nonce=x');
    assert.equal(endpoint(node('a', 'http://remote.test/prefix'), '/ws', true), 'ws://remote.test/prefix/ws');
    assert.equal(endpoint(node('local'), '/ws'), 'https://app.test/ws');
    assert.equal(endpoint(node('a', 'https://remote.test//prefix'), '/ws'), 'https://remote.test//prefix/ws');
    for (const base of ['javascript:alert(1)', '//evil.test', 'https://user:pass@remote.test']) assert.throws(() => endpoint(node('x', base), '/ws'));
    assert.throws(() => endpoint(node('local'), '//evil.test'));
});

test('capability and HTTPS restrictions apply; URL takes priority; manual selection persists IDs and queries', async () => {
    const env = setup({ nodes: [node('local'), node('remote', 'https://remote.test/p'), node('http', 'http://remote.test'), node('speed', '', ['speedtest'])], href: 'https://app.test/?node=remote&keep=1', stored: 'local' });
    assert.equal(env.select.disabled, true);
    await env.picker.ready;
    assert.equal(env.picker.selected.id, 'remote');
    assert.equal(env.select.children.some(option => option.value === 'speed'), false);
    const insecure = env.select.children.find(option => option.value === 'http');
    assert.equal(insecure.disabled, true);
    assert.match(insecure.textContent, /HTTPS/);
    env.select.value = 'local';
    env.select.fire('change');
    assert.equal(env.storage.get('packetloss.node'), 'local');
    assert.equal(env.window.location.searchParams.get('keep'), '1');
    assert.equal(env.window.location.searchParams.get('node'), 'local');
    const link = new URL(env.link.getAttribute('href'));
    assert.equal(link.searchParams.get('other'), '2');
    assert.equal(link.searchParams.get('node'), 'local');
    assert.equal(link.hash, '#details');
    assert.equal(env.status.attributes['aria-live'], 'polite');
    assert.equal(env.calls[0].options.credentials, 'omit');
    assert.equal(env.calls[0].options.cache, 'no-store');
});

test('explicit invalid, unsupported, insecure, or empty query never silently falls back', async () => {
    for (const id of ['missing', 'speed', 'http', '', 'https://evil.test']) {
        const env = setup({ href: 'https://app.test/?node=' + encodeURIComponent(id), nodes: [node('local'), node('speed', '', ['speedtest']), node('http', 'http://remote.test')], stored: 'local' });
        await env.picker.ready;
        assert.equal(env.picker.selected, null);
        assert.deepEqual(env.changes, [null]);
        assert.match(env.status.textContent, /URL/);
        env.select.value = 'local';
        env.select.fire('change');
        assert.equal(env.picker.selected.id, 'local');
    }
});

test('storage priority, stale fallback, restricted storage, and ignored custom endpoint queries', async () => {
    for (const options of [{ stored: 'remote', expected: 'remote' }, { stored: 'gone', expected: 'local' }, { restricted: true, expected: 'local' }]) {
        const env = setup({ ...options, href: 'https://app.test/?endpoint=https://evil.test', nodes: [node('remote', 'https://remote.test'), node('local')] });
        await env.picker.ready;
        assert.equal(env.picker.selected.id, options.expected);
        env.select.value = 'remote';
        env.select.fire('change');
        assert.equal(env.picker.selected.id, 'remote');
    }
    const env = setup({ nodes: [node('first', 'https://first.test')], stored: 'gone' });
    await env.picker.ready;
    assert.equal(env.picker.selected.id, 'first');
});

test('load failure resolves ready and notifies null without an unhandled rejection', async () => {
    for (const api of [async () => { throw new Error('offline'); }, async () => ({ ok: false }), async () => ({ ok: true, json: async () => ({}) })]) {
        const env = setup({ api });
        await env.picker.ready;
        assert.equal(env.picker.selected, null);
        assert.deepEqual(env.changes, [null]);
        assert.match(env.status.textContent, /失败/);
    }
});

test('probe concurrency is three; three samples per node; selection stays manual', async () => {
    let active = 0;
    let maximum = 0;
    const pending = [];
    const env = setup({ nodes: Array.from({ length: 5 }, (_, i) => node('n' + i, 'https://remote.test/prefix')), request: () => {
        active++;
        maximum = Math.max(maximum, active);
        return new Promise(resolve => pending.push(() => { active--; resolve({ ok: true, json: async () => ({ ok: true }) }); }));
    } });
    await env.picker.ready;
    const done = env.probeButton.fire('click');
    await flush();
    assert.equal(env.probeButton.disabled, true);
    assert.equal(env.select.disabled, false);
    env.probeButton.fire('click');
    env.select.value = 'n4'; env.select.fire('change');
    for (const duration of [10, 30, 20, 10, 30, 20]) {
        await env.tick(duration);
        pending.splice(0).forEach(resolve => resolve());
        await flush();
    }
    await done;
    assert.equal(maximum, 3);
    assert.equal(env.calls.length, 16);
    assert.equal(env.picker.selected.id, 'n4');
    assert.match(env.status.textContent, /5\/5 个节点可达/);
    assert.ok(env.select.children.some(option => option.textContent.includes('HTTP 探测 20ms')));
    assert.equal(env.timers.size, 0);
    for (const call of env.calls.slice(1)) {
        assert.match(call.url, /^https:\/\/remote.test\/prefix\/speedtest\/ping\?nonce=/);
        assert.equal(call.options.method, 'GET');
        assert.equal(call.options.credentials, 'omit');
        assert.equal(call.options.cache, 'no-store');
    }
});

test('timeouts cover hanging JSON; invalid JSON payload and HTTP errors are unreachable', async () => {
    for (const response of [{ ok: true, json: () => new Promise(() => {}) }, { ok: true, json: async () => ({ ok: false }) }, { ok: false }]) {
        const env = setup({ request: async () => response });
        await env.picker.ready;
        const done = env.probeButton.fire('click');
        await flush();
        for (let i = 0; i < 3; i++) await env.tick(2000);
        await done;
        assert.match(env.status.textContent, /0\/1 个节点可达/);
        assert.ok(env.select.children.some(option => option.textContent.includes('不可达')));
        assert.equal(env.calls.length, 4);
        assert.equal(env.timers.size, 0);
        assert.equal(env.picker.selected.id, 'local');
    }
});

test('lock cancels requests and timers; old body completion cannot pollute a new round', async () => {
    const bodies = [];
    const env = setup({ nodes: [node('local'), node('other')], request: async () => ({ ok: true, json: () => new Promise(resolve => bodies.push(resolve)) }) });
    await env.picker.ready;
    const old = env.probeButton.fire('click');
    await flush();
    env.picker.setLocked(true);
    assert.equal(env.timers.size, 0);
    assert.equal(env.select.disabled, true);
    assert.equal(env.probeButton.disabled, true);
    env.select.value = 'other'; env.select.fire('change');
    assert.equal(env.picker.selected.id, 'local');
    assert.equal(env.select.value, 'local');
    assert.ok(env.calls.slice(1).every(call => call.options.signal.aborted));
    await old;
    env.picker.setLocked(false);
    const fresh = env.probeButton.fire('click');
    await flush();
    bodies.splice(0, 2).forEach(resolve => resolve({ ok: true }));
    await flush();
    assert.equal(env.status.textContent, '正在进行 HTTP 探测…');
    assert.ok(env.select.children.every(option => !option.textContent.includes('ms')));
    env.picker.destroy();
    await fresh;
    assert.equal(env.timers.size, 0);
    assert.equal(env.select.listeners.change, undefined);
});

test('loading while locked does not change selection until unlocked', async () => {
    const env = setup();
    env.picker.setLocked(true);
    await env.picker.ready;
    assert.equal(env.picker.selected, null);
    env.picker.setLocked(false);
    assert.equal(env.picker.selected.id, 'local');
});

test('HTTP pages allow HTTP nodes; no matching capability remains unselected', async () => {
    const env = setup({ href: 'http://app.test/', nodes: [node('http', 'http://remote.test')] });
    await env.picker.ready;
    assert.equal(env.picker.selected.id, 'http');
    const empty = setup({ nodes: [node('speed', '', ['speedtest'])] });
    await empty.picker.ready;
    assert.equal(empty.picker.selected, null);
    assert.equal(empty.probeButton.disabled, true);
    assert.deepEqual(empty.changes, [null]);
});

test('hanging fetch times out and clears all timers after three attempts', async () => {
    const env = setup({ request: () => new Promise(() => {}) });
    await env.picker.ready;
    const done = env.probeButton.fire('click');
    await flush();
    for (let i = 0; i < 3; i++) await env.tick(2000);
    await done;
    assert.equal(env.calls.length, 4);
    assert.equal(env.timers.size, 0);
    assert.ok(env.calls.slice(1).every(call => call.options.signal.aborted));
    assert.match(env.status.textContent, /0\/1 个节点可达/);
});

test('directory loading has a deadline including the response body', async () => {
    const env = setup({ api: async ({ signal }) => ({ ok: true, json: () => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('timeout')));
    }) }) });
    await flush();
    await env.tick(10000);
    await env.picker.ready;
    assert.equal(env.picker.selected, null);
    assert.match(env.status.textContent, /加载失败/);
    assert.equal(env.select.disabled, true);
    assert.equal(env.timers.size, 0);
});
