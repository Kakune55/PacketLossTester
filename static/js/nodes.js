(function () {
    'use strict';

    function endpoint(node, path, websocket = false) {
        const base = node.baseUrl === '' ? window.location.origin : node.baseUrl;
        const url = new URL(base);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
            throw new Error('Invalid node URL');
        }
        if (typeof path !== 'string' || /^(?:[a-z]+:|\/\/)/i.test(path) ||
            path.split(/[/?#]/).some(part => part === '..' || part === '.')) {
            throw new Error('Invalid endpoint path');
        }
        url.search = '';
        url.hash = '';
        const result = new URL(url.href.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, ''));
        if (websocket) result.protocol = result.protocol === 'https:' ? 'wss:' : 'ws:';
        return result.href;
    }

    function create({ capability, select, probeButton, status, onChange }) {
        let selected = null;
        let loaded = false;
        let locked = false;
        let destroyed = false;
        let initialized = false;
        let initialID = null;
        let selectionMessage = '';
        let round = null;
        const entries = [];
        const loading = new AbortController();
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        status.textContent = '正在加载节点…';
        select.replaceChildren();
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = '请选择节点';
        select.appendChild(placeholder);

        function controls() {
            select.disabled = destroyed || locked || !loaded || !entries.some(entry => !entry.option.disabled);
            probeButton.disabled = destroyed || locked || !loaded || !!round || !entries.some(entry => !entry.option.disabled);
        }

        function notify() {
            if (typeof onChange === 'function') {
                try { onChange(selected); } catch (_) { status.textContent = '节点选择回调失败'; }
            }
        }

        function persist(manual) {
            if (!selected) return;
            try { window.localStorage.setItem('packetloss.node', selected.id); } catch (_) { /* Storage is optional. */ }
            if (manual) {
                try {
                    const url = new URL(window.location.href);
                    url.searchParams.set('node', selected.id);
                    window.history.replaceState(null, '', url.href);
                } catch (_) { /* History can be restricted in embedded pages. */ }
            }
            document.querySelectorAll('[data-node-link]').forEach(link => {
                try {
                    const url = new URL(link.getAttribute('href'), window.location.href);
                    if (url.origin !== window.location.origin || !['http:', 'https:'].includes(url.protocol)) return;
                    url.searchParams.set('node', selected.id);
                    link.setAttribute('href', url.href);
                } catch (_) { /* Ignore malformed navigation links. */ }
            });
        }

        function choose(id, manual) {
            const entry = entries.find(item => item.node.id === id && !item.option.disabled);
            selected = entry ? entry.node : null;
            select.value = selected ? selected.id : '';
            selectionMessage = selected ? '已选择节点：' + selected.name : '请选择可用节点';
            status.textContent = selectionMessage;
            persist(manual);
            notify();
        }

        function change() {
            if (locked || destroyed || !loaded) {
                select.value = selected ? selected.id : '';
                return;
            }
            choose(select.value, true);
        }

        function cancelProbe() {
            if (!round) return;
            const previous = round;
            round = null;
            previous.abort();
            status.textContent = selectionMessage;
            controls();
        }

        // The deadline covers both the response headers and JSON body. Aborting also
        // settles immediately when a transport does not cooperate with AbortSignal.
        function sample(node, signal) {
            return new Promise(resolve => {
                const controller = new AbortController();
                const started = performance.now();
                let timer;
                let settled = false;
                function finish(value) {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    signal.removeEventListener('abort', abort);
                    controller.abort();
                    resolve(value);
                }
                function abort() { finish(null); }
                signal.addEventListener('abort', abort, { once: true });
                if (signal.aborted) { abort(); return; }
                timer = setTimeout(abort, 2000);
                Promise.resolve().then(() => {
                    if (settled) return null;
                    const url = new URL(endpoint(node, '/speedtest/ping'));
                    url.searchParams.set('nonce', Date.now() + '-' + Math.random());
                    return fetch(url.href, { method: 'GET', credentials: 'omit', cache: 'no-store', signal: controller.signal });
                }).then(response => {
                    if (settled) return null;
                    if (!response || !response.ok) throw new Error('HTTP probe failed');
                    return response.json();
                }).then(body => {
                    finish(body && body.ok === true ? performance.now() - started : null);
                }, () => finish(null));
            });
        }

        async function probe() {
            if (destroyed || locked || !loaded || round) return;
            const current = new AbortController();
            round = current;
            controls();
            status.textContent = '正在进行 HTTP 探测…';
            const available = entries.filter(entry => !entry.option.disabled);
            available.forEach(entry => { entry.option.textContent = entry.label; });
            let next = 0;
            const summaries = new Array(available.length);
            async function worker() {
                while (round === current) {
                    const index = next++;
                    if (index >= available.length) return;
                    const entry = available[index];
                    const samples = [];
                    for (let i = 0; i < 3; i++) {
                        const value = await sample(entry.node, current.signal);
                        if (round !== current) return;
                        samples.push(value);
                    }
                    samples.sort((a, b) => a - b);
                    const result = samples.some(value => value === null) ? '不可达' : 'HTTP 探测 ' + Math.round(samples[1]) + 'ms';
                    entry.option.textContent = entry.label + ' · ' + result;
                    summaries[index] = samples.every(value => value !== null);
                }
            }
            try {
                await Promise.all(Array.from({ length: Math.min(3, available.length) }, worker));
                if (round !== current) return;
                status.textContent = `HTTP 探测完成：${summaries.filter(Boolean).length}/${available.length} 个节点可达，详情见选项`;
            } catch (_) {
                if (round === current) status.textContent = 'HTTP 探测失败';
            } finally {
                if (round === current) { round = null; controls(); }
            }
        }

        select.addEventListener('change', change);
        probeButton.addEventListener('click', probe);
        controls();
        const ready = (async () => {
            const timer = setTimeout(() => loading.abort(), 10000);
            try {
                const response = await fetch('/api/nodes', { credentials: 'omit', cache: 'no-store', signal: loading.signal });
                if (!response.ok) throw new Error('Nodes unavailable');
                const body = await response.json();
                if (!body || !Array.isArray(body.nodes)) throw new Error('Invalid nodes');
                if (destroyed) return;
                const ids = new Set();
                for (const node of body.nodes) {
                    if (!node || typeof node.id !== 'string' || !node.id || ids.has(node.id) ||
                        typeof node.baseUrl !== 'string' || !Array.isArray(node.capabilities) || !node.capabilities.includes(capability)) continue;
                    let url;
                    try { url = new URL(endpoint(node, '/speedtest/ping')); } catch (_) { continue; }
                    ids.add(node.id);
                    const option = document.createElement('option');
                    option.value = node.id;
                    option.disabled = window.location.protocol === 'https:' && url.protocol === 'http:';
                    const label = (node.name || node.id) + (node.region ? ' (' + node.region + ')' : '') +
                        (option.disabled ? ' · HTTPS 页面禁止 HTTP 节点' : '');
                    option.textContent = label;
                    select.appendChild(option);
                    entries.push({ node, option, label });
                }
                const query = new URL(window.location.href).searchParams;
                if (query.has('node')) {
                    initialID = query.get('node');
                    if (!entries.some(entry => entry.node.id === initialID && !entry.option.disabled)) {
                        initialID = null;
                        selectionMessage = 'URL 指定的节点不存在、不支持此测试或因 HTTPS 安全限制不可用，请手动选择';
                    }
                } else {
                    let stored;
                    try { stored = window.localStorage.getItem('packetloss.node'); } catch (_) { /* Storage is optional. */ }
                    const available = entries.filter(entry => !entry.option.disabled);
                    const initial = available.find(entry => entry.node.id === stored) ||
                        available.find(entry => entry.node.id === 'local' || entry.node.baseUrl === '') || available[0];
                    initialID = initial ? initial.node.id : null;
                    if (!initial) selectionMessage = '没有可用于此测试的节点（HTTPS 页面禁止 HTTP 节点）';
                }
                if (!locked) {
                    initialized = true;
                    if (initialID !== null) choose(initialID, false);
                    else { select.value = ''; status.textContent = selectionMessage; notify(); }
                } else { status.textContent = selectionMessage || '节点已加载，等待解锁'; notify(); }
            } catch (_) {
                if (!destroyed) { initialized = true; status.textContent = '节点加载失败，请刷新重试'; notify(); }
            } finally {
                clearTimeout(timer);
                loaded = true;
                controls();
            }
        })();

        return {
            get selected() { return selected; },
            ready,
            setLocked(value) {
                locked = !!value;
                if (locked) cancelProbe();
                if (!locked && loaded && !initialized && !destroyed) {
                    initialized = true;
                    if (initialID !== null) choose(initialID, false);
                    else { status.textContent = selectionMessage; notify(); }
                }
                controls();
            },
            destroy() {
                destroyed = true;
                loading.abort();
                cancelProbe();
                select.removeEventListener('change', change);
                probeButton.removeEventListener('click', probe);
                controls();
            },
        };
    }

    window.TestNodes = { create, endpoint };
})();
