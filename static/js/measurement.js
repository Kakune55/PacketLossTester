(function (root) {
    'use strict';
    const REPLY_TIMEOUT_MS = 3000;
    const MAX_BUFFERED_BYTES = 1024 * 1024;

    class Measurement {
        constructor({ stress = false, windowMs = 10000 } = {}) {
            this.windowMs = stress ? windowMs : Infinity;
            this.packets = new Map();
            this.queue = [];
            this.head = 0;
            this.expiryHead = 0;
            this.phase = 'connecting';
            this.received = 0;
            this.lost = 0;
            this.sum = 0;
            this.jitterSum = 0;
            this.first = null;
            this.last = null;
            this.sorted = [];
            this.dirty = false;
        }

        start() {
            if (this.phase !== 'connecting') return false;
            this.phase = 'sending';
            return true;
        }

        send(id, sentTime) {
            if (this.phase !== 'sending' || this.packets.has(id)) return false;
            const packet = { id, sentTime, state: 'pending' };
            this.packets.set(id, packet);
            this.queue.push(packet);
            return true;
        }

        receive(id, echoedTime, now) {
            if (this.phase !== 'sending' && this.phase !== 'draining') return false;
            this.advance(now);
            const p = this.packets.get(id);
            if (!p || p.state !== 'pending' || echoedTime !== p.sentTime || now < p.sentTime) return false;
            p.state = 'received';
            p.latency = now - p.sentTime;
            p.prev = this.last;
            p.next = null;
            if (this.last) {
                this.last.next = p;
                this.jitterSum += Math.abs(p.latency - this.last.latency);
            } else {
                this.first = p;
            }
            this.last = p;
            this.received++;
            this.sum += p.latency;
            this.dirty = true;
            return true;
        }

        advance(now) {
            if (this.phase === 'finished') return;
            const cutoff = (this.stoppedAt ?? now) - this.windowMs;
            while (this.head < this.queue.length && this.queue[this.head].sentTime < cutoff) {
                const p = this.queue[this.head++];
                this.packets.delete(p.id);
                if (p.state === 'lost') this.lost--;
                if (p.state === 'received') {
                    const { prev, next } = p;
                    if (prev) this.jitterSum -= Math.abs(p.latency - prev.latency);
                    if (next) this.jitterSum -= Math.abs(p.latency - next.latency);
                    if (prev && next) this.jitterSum += Math.abs(prev.latency - next.latency);
                    if (prev) prev.next = next; else this.first = next;
                    if (next) next.prev = prev; else this.last = prev;
                    p.prev = p.next = null;
                    this.received--;
                    this.sum -= p.latency;
                    this.dirty = true;
                }
            }
            this.expiryHead = Math.max(this.expiryHead, this.head);
            while (this.expiryHead < this.queue.length && now - this.queue[this.expiryHead].sentTime >= REPLY_TIMEOUT_MS) {
                const p = this.queue[this.expiryHead++];
                if (p.state === 'pending') {
                    p.state = 'lost';
                    this.lost++;
                }
            }
            // Each packet is visited once for expiry and once for window eviction.
            if (this.head >= 1024 && this.head * 2 >= this.queue.length) {
                this.queue = this.queue.slice(this.head);
                this.expiryHead -= this.head;
                this.head = 0;
            }
        }

        stop(now) {
            if (this.phase === 'finished' || this.phase === 'draining') return false;
            this.advance(now);
            this.stoppedAt = now;
            this.phase = 'draining';
            return true;
        }

        get pending() {
            return this.packets.size - this.received - this.lost;
        }

        finish(now) {
            if (this.phase !== 'draining') return false;
            this.advance(now);
            if (this.pending) return false;
            this.phase = 'finished';
            return true;
        }

        snapshot(now) {
            this.advance(now);
            if (this.dirty) {
                this.sorted = [];
                for (let p = this.first; p; p = p.next) this.sorted.push(p.latency);
                this.sorted.sort((a, b) => a - b);
                this.dirty = false;
            }
            const n = this.received;
            const settled = n + this.lost;
            return {
                sent: this.packets.size, received: n, lost: this.lost, pending: this.pending,
                lossRate: settled ? this.lost / settled * 100 : null,
                avg: n ? this.sum / n : null,
                min: n ? this.sorted[0] : null,
                max: n ? this.sorted[n - 1] : null,
                p90: n ? this.sorted[Math.ceil(n * 0.9) - 1] : null,
                jitter: n > 1 ? Math.max(0, this.jitterSum) / (n - 1) : null,
            };
        }
    }

    const api = { Measurement, REPLY_TIMEOUT_MS, MAX_BUFFERED_BYTES };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.PacketMeasurement = api;
})(globalThis);
