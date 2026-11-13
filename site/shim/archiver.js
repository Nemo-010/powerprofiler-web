/*
 * `archiver` stub: writes stored-method (uncompressed) ZIP entries so the
 * app can export `.ppk2` session archives in the browser. Upstream zips
 * recorded sample chunks (already deflate-compressed payloads), so stored
 * entries keep exports readable by the real app while avoiding a full
 * deflate implementation.
 */
(function () {
    'use strict';

    const CRC_TABLE = (() => {
        const table = new Uint32Array(256);
        for (let n = 0; n < 256; n += 1) {
            let c = n;
            for (let k = 0; k < 8; k += 1) {
                c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
            }
            table[n] = c >>> 0;
        }
        return table;
    })();

    const crc32 = bytes => {
        let c = 0xFFFFFFFF;
        for (let i = 0; i < bytes.length; i += 1) {
            c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
        }
        return (c ^ 0xFFFFFFFF) >>> 0;
    };

    const dosTime = date => ({
        time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
        date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    });

    class Archive {
        constructor(format, options) {
            this.format = format; // 'zip'
            this.options = options || {};
            this.__entries = []; // {name, data: Uint8Array}
            this.__events = { data: [], warning: [], error: [], end: [], close: [], entry: [], progress: [], finish: [] };
            this.__finalized = false;
            this.writable = true;
        }

        on(name, fn) {
            (this.__events[name] = this.__events[name] || []).push(fn);
            return this;
        }
        off(name, fn) {
            this.__events[name] = (this.__events[name] || []).filter(f => f !== fn);
            return this;
        }
        once(name, fn) {
            const wrapped = arg => { this.off(name, wrapped); fn(arg); };
            return this.on(name, wrapped);
        }
        emit(name, arg) {
            (this.__events[name] || []).forEach(fn => fn(arg));
            return true;
        }
        removeListener(name, fn) { return this.off(name, fn); }
        addListener(name, fn) { return this.on(name, fn); }

        append(data, opts) {
            if (this.__finalized) throw new Error('append after finalize');
            const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data));
            this.__entries.push({ name: opts && opts.name ? opts.name : 'entry', data: bytes, date: (opts && opts.date) || new Date() });
            this.emit('entry');
            return this;
        }

        directory(vfsPath, base) {
            // walk the virtual fs and add every file under it
            const vfs = window.__vfs;
            const names = [];
            const prefix = vfsPath.endsWith('/') ? vfsPath : `${vfsPath}/`;
            for (const p of vfs.__allFiles ? vfs.__allFiles() : this.__allFilesFallback(vfsPath)) {
                if (p.startsWith(prefix)) {
                    names.push(p);
                }
            }
            for (const p of names) {
                const rel = base === false ? p.slice(prefix.length) : `${base || ''}${p.slice(prefix.length)}`;
                const data = window.__fsShim.readFileSync(p);
                this.__entries.push({
                    name: rel,
                    data: data instanceof Uint8Array ? data : window.__nodeBuffer.from(data),
                    date: new Date(),
                });
            }
            this.emit('entry');
            return this;
        }

        __allFilesFallback(root) {
            // readdir returns direct children; sessions are one level deep in
            // practice, so walk two levels
            const out = [];
            for (const name of window.__fsShim.readdirSync(root)) {
                const p = `${root}/${name}`;
                if (window.__vfs.isFile(p)) {
                    out.push(p);
                } else {
                    for (const sub of window.__fsShim.readdirSync(p)) {
                        const sp = `${p}/${sub}`;
                        if (window.__vfs.isFile(sp)) out.push(sp);
                    }
                }
            }
            return out;
        }

        pipe(dest) {
            this.__dest = dest;
            return dest;
        }

        async finalize() {
            if (this.__finalized) return;
            this.__finalized = true;
            const zip = this.__buildZip();
            // stream out in chunks, mimicking archiver's event flow
            const CHUNK = 64 * 1024;
            for (let offset = 0; offset < zip.length; offset += CHUNK) {
                this.emit('data', window.__nodeBuffer.from(zip.subarray(offset, offset + CHUNK)));
                if (this.__dest && this.__dest.write) {
                    this.__dest.write(window.__nodeBuffer.from(zip.subarray(offset, offset + CHUNK)));
                }
                await new Promise(r => { setTimeout(r, 0); });
            }
            if (this.__dest && this.__dest.end) this.__dest.end();
            this.emit('end');
            this.emit('finish');
            this.emit('close');
        }

        abort() { this.__finalized = true; }

        __buildZip() {
            const encoder = new TextEncoder();
            const locals = [];
            const central = [];
            let offset = 0;
            for (const entry of this.__entries) {
                const nameBytes = encoder.encode(entry.name);
                const crc = crc32(entry.data);
                const { time, date } = dosTime(entry.date);
                const local = new Uint8Array(30 + nameBytes.length);
                const dv = new DataView(local.buffer);
                dv.setUint32(0, 0x04034b50, true);
                dv.setUint16(4, 20, true);      // version needed
                dv.setUint16(6, 0x0800, true);  // UTF-8 flag
                dv.setUint16(8, 0, true);       // stored
                dv.setUint16(10, time, true);
                dv.setUint16(12, date, true);
                dv.setUint32(14, crc, true);
                dv.setUint32(18, entry.data.length, true);
                dv.setUint32(22, entry.data.length, true);
                dv.setUint16(26, nameBytes.length, true);
                dv.setUint16(28, 0, true);
                local.set(nameBytes, 30);
                locals.push(local, entry.data);

                const centralEntry = new Uint8Array(46 + nameBytes.length);
                const cv = new DataView(centralEntry.buffer);
                cv.setUint32(0, 0x02014b50, true);
                cv.setUint16(4, 20, true);      // version made by
                cv.setUint16(6, 20, true);      // version needed
                cv.setUint16(8, 0x0800, true);
                cv.setUint16(10, 0, true);
                cv.setUint16(12, time, true);
                cv.setUint16(14, date, true);
                cv.setUint32(16, crc, true);
                cv.setUint32(20, entry.data.length, true);
                cv.setUint32(24, entry.data.length, true);
                cv.setUint16(28, nameBytes.length, true);
                cv.setUint16(42, offset, true);
                centralEntry.set(nameBytes, 46);
                central.push(centralEntry);
                offset += local.length + entry.data.length;
            }
            const eocd = new Uint8Array(22);
            const ev = new DataView(eocd.buffer);
            ev.setUint32(0, 0x06054b50, true);
            ev.setUint16(8, this.__entries.length, true);
            ev.setUint16(10, this.__entries.length, true);
            ev.setUint32(12, central.reduce((sum, c) => sum + c.length, 0), true);
            ev.setUint32(16, offset, true);
            const total = locals.reduce((s, b) => s + b.length, 0)
                + central.reduce((s, b) => s + b.length, 0) + eocd.length;
            const out = new Uint8Array(total);
            let pos = 0;
            for (const part of [...locals, ...central, eocd]) {
                out.set(part, pos);
                pos += part.length;
            }
            return out;
        }
    }

    const archiver = (format, options) => new Archive(format, options);
    archiver.create = (format, options) => new Archive(format, options);
    archiver.registerFormat = () => undefined;
    archiver.isRegisteredFormat = () => format => format === 'zip';

    window.__archiverShim = archiver;
})();
