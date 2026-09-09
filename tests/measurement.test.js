const test = require('node:test');
const assert = require('node:assert/strict');
const { Measurement, REPLY_TIMEOUT_MS } = require('../static/js/measurement.js');

function started(options) {
    const m = new Measurement(options);
    assert.equal(m.start(), true);
    return m;
}

test('pending is excluded, zero replies settle to 100%, finish is immutable', () => {
    const m = started();
    m.send(0, 0);
    assert.equal(m.snapshot(100).lossRate, null);
    m.stop(100);
    assert.equal(m.finish(2999), false);
    assert.equal(m.send(1, 200), false);
    assert.equal(m.finish(REPLY_TIMEOUT_MS), true);
    assert.equal(m.snapshot(9000).lossRate, 100);
    assert.equal(m.snapshot(9000).pending, 0);
    assert.equal(m.receive(0, 0, 3001), false);
});

test('drain accepts valid replies and finishes early; duplicates and invalid echoes are ignored', () => {
    const m = started();
    m.send(0, 10);
    m.send(1, 20);
    m.stop(30);
    assert.equal(m.stop(40), false);
    assert.equal(m.receive(0, 11, 40), false);
    assert.equal(m.receive(0, 10, 9), false);
    assert.equal(m.receive(99, 10, 40), false);
    assert.equal(m.receive(0, 10, 40), true);
    assert.equal(m.receive(0, 10, 50), false);
    assert.equal(m.receive(1, 20, 60), true);
    assert.equal(m.finish(60), true);
    assert.deepEqual(m.snapshot(60), {
        sent: 2, received: 2, lost: 0, pending: 0, lossRate: 0,
        avg: 35, min: 30, max: 40, p90: 40, jitter: 10,
    });
});

test('nearest-rank P90 and all-session samples are not truncated to 2000', () => {
    const m = started();
    for (let i = 0; i < 2500; i++) {
        m.send(i, i * 4000);
        m.receive(i, i * 4000, i * 4000 + (i < 2300 ? 100 : 200));
    }
    const s = m.snapshot(10000000);
    assert.equal(s.received, 2500);
    assert.equal(s.p90, 100);
    assert.equal(s.avg, 108);
    const ten = started();
    for (let i = 0; i < 10; i++) ten.send(i, 0);
    for (let i = 0; i < 10; i++) ten.receive(i, 0, i + 1);
    assert.equal(ten.snapshot(10).p90, 9);
});

test('window eviction repairs arrival-order jitter even when middle sample expires', () => {
    const m = started({ stress: true, windowMs: 100 });
    m.send(0, 0);
    m.send(1, 10);
    m.send(2, 20);
    m.receive(1, 10, 30); // RTT 20
    m.receive(0, 0, 40); // RTT 40, middle arrival but oldest send
    m.receive(2, 20, 50); // RTT 30
    assert.equal(m.snapshot(50).jitter, 15);
    const s = m.snapshot(101);
    assert.equal(s.sent, 2);
    assert.equal(s.avg, 25);
    assert.equal(s.jitter, 10);
    assert.equal(s.p90, 30);
    assert.equal(m.snapshot(121).avg, null);
    assert.equal(m.snapshot(121).jitter, null);
});

test('stress stop freezes sending cohort during drain, deadline excludes late replies', () => {
    const m = started({ stress: true });
    m.send(0, 0);
    m.send(1, 9999);
    m.send(2, 10000);
    m.stop(10000);
    assert.equal(m.snapshot(12000).sent, 3);
    assert.equal(m.receive(1, 9999, 12998), true);
    assert.equal(m.receive(2, 10000, 13000), false);
    assert.equal(m.finish(13000), true);
    assert.equal(m.snapshot(99999).sent, 3);
    assert.equal(m.snapshot(99999).lost, 2);
});

test('incremental queues stay bounded in a long stress run', () => {
    const m = started({ stress: true });
    for (let i = 0; i < 100000; i++) {
        const now = i * 10;
        m.send(i, now);
        m.receive(i, now, now + 1);
    }
    const s = m.snapshot(999991);
    assert.equal(s.sent, 1000);
    assert.equal(s.received, 1000);
    assert.equal(s.jitter, 0);
    assert.ok(m.queue.length < 2100);
});

test('stopping before connection has no fabricated loss', () => {
    const m = new Measurement();
    assert.equal(m.send(0, 0), false);
    assert.equal(m.stop(10), true);
    assert.equal(m.start(), false);
    assert.equal(m.finish(10), true);
    assert.equal(m.snapshot(10).lossRate, null);
});
