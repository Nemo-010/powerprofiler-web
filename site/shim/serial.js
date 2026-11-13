/*
 * WebSerial device manager.
 *
 * Replaces native serialport + the forked serial worker. Ports are
 * enumerated through navigator.serial, opened with 115200-8-N-1, and data is
 * batched into ~30 ms chunks to mirror the upstream worker protocol exactly.
 */
(function () {
    'use strict';

    const FLUSH_INTERVAL_MS = 30;
    const BAUD = 115200;

    const USB_IDS = {
        0x1366: { 0xC00A: 'PPK2' },   // SEGGER vid, nRF Connect PPK2
        0x1915: { 0x521F: 'PPK1' },   // Nordic vid, nRF Connect PPK
    };

    const nameFor = (vid, pid) => (USB_IDS[vid] && USB_IDS[vid][pid]) || 'Unknown device';

    class WebSerialManager {
        constructor() {
            this.ports = new Map(); // key -> { port, info, open }
            this.hotplugListeners = new Set();
            this.__counter = 0;
        }

        get supported() {
            return typeof navigator !== 'undefined' && !!navigator.serial;
        }

        async init() {
            if (!this.supported) return [];
            navigator.serial.addEventListener('connect', async e => {
                const entry = await this.__addPort(e.target || e.port);
                if (entry) this.__notifyHotplug('Arrived', entry);
            });
            navigator.serial.addEventListener('disconnect', async e => {
                const entry = await this.__findEntryByPort(e.target || e.port);
                if (entry) {
                    await this.close(entry.key);
                    this.ports.delete(entry.key);
                    this.__notifyHotplug('Left', entry);
                }
            });
            const list = await navigator.serial.getPorts();
            for (const port of list) {
                await this.__addPort(port);
            }
            return [...this.ports.values()].map(e => e.key);
        }

        __notifyHotplug(event, entry) {
            this.hotplugListeners.forEach(fn => {
                try {
                    fn(event, entry);
                } catch (err) {
                    console.error('hotplug listener failed', err);
                }
            });
        }

        __infoFromPort(port) {
            const info = port.getInfo ? port.getInfo() : {};
            const vid = info.usbVendorId;
            const pid = info.usbProductId;
            if (vid === undefined) return null;
            const key = `webserial-${vid}-${pid}-${this.__assignedKey(port)}`;
            return {
                key,
                usbVendorId: vid,
                usbProductId: pid,
                product: nameFor(vid, pid),
            };
        }

        __assignedKey(port) {
            // stable within a session; enumerated order is consistent per origin
            if (!port.__keyIndex) {
                this.__counter += 1;
                port.__keyIndex = this.__counter;
            }
            return port.__keyIndex;
        }

        async __addPort(port) {
            const info = this.__infoFromPort(port);
            if (!info) return null;
            if ([...this.ports.values()].some(e => e.port === port)) {
                return [...this.ports.values()].find(e => e.port === port);
            }
            const entry = {
                key: info.key,
                port,
                info,
                open: null,
                comPath: `/webserial/${info.key}`,
                serialNumber: `WEB-${info.usbVendorId.toString(16).toUpperCase()}-${info.usbProductId.toString(16).toUpperCase()}-${info.key}`,
            };
            this.ports.set(entry.key, entry);
            return entry;
        }

        async __findEntryByPort(port) {
            for (const entry of this.ports.values()) {
                if (entry.port === port) return entry;
            }
            return null;
        }

        // user gesture required; resolves with the entry or null
        async requestPair() {
            if (!this.supported) {
                throw new Error('WebSerial is not supported by this browser.');
            }
            const filters = [];
            for (const [vid, pids] of Object.entries(USB_IDS)) {
                for (const pid of Object.keys(pids)) {
                    filters.push({
                        usbVendorId: parseInt(vid, 16),
                        usbProductId: parseInt(pid, 16),
                    });
                }
            }
            let port;
            try {
                port = await navigator.serial.requestPort({ filters });
            } catch (err) {
                return null; // user cancelled or no matching device
            }
            const entry = await this.__addPort(port);
            if (entry) this.__notifyHotplug('Arrived', entry);
            return entry;
        }

        async open(key) {
            const entry = this.ports.get(key);
            if (!entry) throw new Error(`Unknown port ${key}`);
            if (entry.open) return entry.open;
            await entry.port.open({ baudRate: BAUD, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
            entry.open = {
                reading: true,
                reader: entry.port.readable.getReader(),
                writer: entry.port.writable.getWriter(),
                pending: [],
                onData: null,
            };
            this.__readLoop(entry);
            return entry.open;
        }

        async __readLoop(entry) {
            const open = entry.open;
            while (open && open.reading) {
                try {
                    const { value, done } = await open.reader.read();
                    if (done) break;
                    if (value && open.onData) {
                        open.pending.push(window.__nodeBuffer.from(value));
                        this.__flushIfDue(entry);
                    }
                } catch (err) {
                    if (open.reading) {
                        // port disappeared
                        open.reading = false;
                        if (open.onError) open.onError(err);
                        if (open.onClose) open.onClose();
                    }
                    break;
                }
            }
        }

        __flushIfDue(entry) {
            const open = entry.open;
            if (!open) return;
            const now = Date.now();
            if (now - (open.lastFlush || 0) >= FLUSH_INTERVAL_MS) {
                open.lastFlush = now;
                this.__flush(entry);
            } else if (!open.flushTimer) {
                open.flushTimer = setTimeout(() => {
                    open.flushTimer = null;
                    this.__flush(entry);
                }, FLUSH_INTERVAL_MS - (now - (open.lastFlush || 0)));
            }
        }

        __flush(entry) {
            const open = entry.open;
            if (!open || open.pending.length === 0 || !open.onData) return;
            const merged = window.__nodeBuffer.concat(open.pending);
            open.pending = [];
            open.onData(merged);
        }

        async write(key, bytes) {
            const entry = this.ports.get(key);
            if (!entry || !entry.open) throw new Error(`Port ${key} is not open`);
            const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
            await entry.open.writer.write(array);
        }

        async close(key) {
            const entry = this.ports.get(key);
            if (!entry || !entry.open) return;
            const open = entry.open;
            open.reading = false;
            try { if (open.reader) await open.reader.cancel(); } catch (e) { /* already closing */ }
            try { if (open.writer) open.writer.releaseLock(); } catch (e) { /* ignore */ }
            try { await entry.port.close(); } catch (e) { /* ignore */ }
            entry.open = null;
        }

        isSupportedDevice(vid, pid) {
            return !!(USB_IDS[vid] && USB_IDS[vid][pid]);
        }
    }

    window.__serialManager = new WebSerialManager();
})();
