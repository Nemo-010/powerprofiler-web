/*
 * `zlib` shim: only what the app uses. createInflateRaw powers .ppk file
 * loading (the recorded samples are raw-deflate compressed); it adapts node
 * streams to the browser's DecompressionStream. gzip/deflate helpers used by
 * telemetry code paths are inert because telemetry is blocked at the CSP.
 */
(function () {
    'use strict';

    const { Transform } = window.__streamClasses;

    const createCompressionTransform = (format, label) => () => new Transform({
        transform(chunk, _encoding, callback) {
            // pass through; decompression is handled at pipeline level via
            // __webTransform when the stream knows it is a zlib stage
            callback(null, chunk);
        },
    });

    // A zlib transform backed by DecompressionStream, integrated with the
    // minimal pipeline through a dedicated pipe path.
    class InflateRawTransform {
        constructor() {
            this.__decoder = new DecompressionStream('deflate-raw');
            this.__writer = this.__decoder.writable.getWriter();
            this.__reader = this.__decoder.readable.getReader();
            this.writable = true;
            this.readable = true;
            this.__events = {};
            this.__chunks = [];
            this.__pump();
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
        async __pump() {
            try {
                for (;;) {
                    const { done, value } = await this.__reader.read();
                    if (done) {
                        this.emit('end');
                        this.emit('close');
                        return;
                    }
                    this.emit('data', window.__nodeBuffer.from(value));
                }
            } catch (err) {
                this.emit('error', err);
            }
        }
        write(chunk, _enc, cb) {
            this.__writer.write(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
                .then(() => { if (cb) cb(); }, err => this.emit('error', err));
            return true;
        }
        end(_chunkOrCb, cb) {
            this.__writer.close().then(
                () => { if (cb) cb(); },
                () => { if (cb) cb(); },
            );
        }
        pipe(dest) {
            this.on('data', chunk => dest.write(chunk));
            this.on('end', () => { if (dest.end) dest.end(); });
            this.on('error', err => { if (dest.emit) dest.emit('error', err); });
            return dest;
        }
    }

    const passthroughFactory = () => new (class extends window.__streamClasses.Transform {})();

    window.__zlibShim = {
        createInflateRaw: () => new InflateRawTransform(),
        createInflate: () => new InflateRawTransform(),
        createGunzip: () => new InflateRawTransform(),
        createDeflateRaw: passthroughFactory,
        createDeflate: passthroughFactory,
        createGzip: passthroughFactory,
        createUnzip: () => new InflateRawTransform(),
        createBrotliDecompress: passthroughFactory,
        gunzipSync: buf => buf,
        inflateRawSync: buf => buf,
        inflateSync: buf => buf,
        gzipSync: buf => buf,
        deflateSync: buf => buf,
        constants: {},
    };
})();
