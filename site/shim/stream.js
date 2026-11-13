/*
 * Minimal node `stream` shim. The app pipelines: fs.createReadStream →
 * zlib inflate → Writable (loading .ppk files) and pipes Transform →
 * fs.createWriteStream (unzipping sessions). This implements just enough
 * Readable/Writable/Duplex/Transform + pipe + pipeline for those paths.
 */
(function () {
    'use strict';

    const EE = window.__eventsShim;

    class Readable extends EE {
        constructor(options) {
            super();
            this.readable = true;
            this.destroyed = false;
            this.__readImpl = options && options.read;
            this.__objectMode = !!(options && options.objectMode);
            this.__flowing = false;
            this.__buffer = [];
        }
        __maybeRead(size) {
            if (this.__readImpl) this.__readImpl(size || 16384);
        }
        push(chunk) {
            if (chunk === null || chunk === undefined) {
                this.pushed = true;
                this.__end();
                return false;
            }
            this.__buffer.push(chunk);
            if (this.__flowing) this.__drain();
            return true;
        }
        _read() { /* subclass hook */ }
        on(name, fn) {
            super.on(name, fn);
            if (name === 'data' && !this.__flowing) {
                this.__flowing = true;
                Promise.resolve().then(() => {
                    this.__drain();
                    this.__maybeRead(16384);
                });
            }
            return this;
        }
        removeListener(name, fn) { return super.off(name, fn); }
        off(name, fn) { return super.off(name, fn); }
        pause() { this.__paused = true; return this; }
        resume() {
            if (this.destroyed) return this;
            this.__paused = false;
            if (this.__flowing) this.__drain();
            this.__maybeRead(16384);
            return this;
        }
        setEncoding() { return this; }
        pipe(dest) {
            if (dest.__pipeSink) {
                dest.__pipeSource = this;
                this.__pipeDest = dest;
                return dest;
            }
            this.on('data', chunk => {
                const ok = dest.write(chunk);
                if (ok === false && dest.pause && this.pause) {
                    dest.once('drain', () => this.resume());
                }
            });
            this.on('end', () => { if (dest.end) dest.end(); });
            this.on('error', err => { if (dest.emit) dest.emit('error', err); });
            if (dest.emit) dest.emit('pipe', this);
            return dest;
        }
        unpipe() { return this; }
        destroy(err) {
            this.destroyed = true;
            this.emit('close');
            if (err) this.emit('error', err);
        }
        __drain() {
            while (this.__buffer.length > 0 && !this.__paused) {
                const chunk = this.__buffer.shift();
                this.emit('data', chunk);
            }
            if (this.pushed && this.__buffer.length === 0 && !this.__endedEmitted) {
                this.__end();
            }
        }
        __end() {
            if (this.__endedEmitted) return;
            this.__endedEmitted = true;
            this.emit('end');
            this.emit('close');
            if (this.__pipeDest && this.__pipeDest.end) this.__pipeDest.end();
        }
    }

    class Writable extends EE {
        constructor(options) {
            super();
            this.writable = true;
            this.destroyed = false;
            this._writableState = { length: 0, ended: false, ending: false, finished: false, destroyed: false, corked: 0, bufferedRequest: null, writing: false, pendingcb: 0 };
            this.__writeImpl = options && options.write;
            this.__finalImpl = options && options.final;
            this.__decodeStrings = !!(options && options.decodeStrings);
        }
        write(chunk, encodingOrCb, cb) {
            const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
            const done = () => {
                if (callback) callback();
                this.emit('drain');
            };
            if (this.__writeImpl) {
                this.__writeImpl(chunk, 'buffer', err => {
                    if (err) {
                        this.emit('error', err);
                        if (callback) callback(err);
                    } else done();
                });
            } else {
                done();
            }
            return true;
        }
        end(chunkOrCb, cb) {
            const finish = () => {
                if (this.__finalImpl) {
                    this.__finalImpl(() => {
                        this.emit('finish');
                        this.emit('close');
                    });
                } else {
                    this.emit('finish');
                    this.emit('close');
                }
                if (typeof chunkOrCb === 'function') chunkOrCb();
                else if (cb) cb();
            };
            if (chunkOrCb && typeof chunkOrCb !== 'function') this.write(chunkOrCb);
            Promise.resolve().then(finish);
            return this;
        }
        destroy(err) {
            this.destroyed = true;
            this.emit('close');
            if (err) this.emit('error', err);
        }
        cork() {}
        uncork() {}
        setTimeout() {}
        get writableFinished() { return this.destroyed; }
    }

    class Duplex extends EE {
        constructor(options) {
            super();
            this.readable = true;
            this.writable = true;
            this.destroyed = false;
            // foreign stream code (readable-stream copies bundled into the app)
            // probes these directly; keep them defined
            this._readableState = { flowing: null, reading: false, length: 0, ended: false, endedEmitted: false, readableListening: false, resumeScheduled: false, destroyed: false, buffer: [] };
            this._writableState = { length: 0, ended: false, ending: false, finished: false, destroyed: false, corked: 0, bufferedRequest: null, writing: false, pendingcb: 0 };
            this.__readImpl = options && options.read;
            this.__writeImpl = options && options.write;
            this.__buffer = [];
            this.__pushedEnd = false;
        }
        push(chunk) {
            if (chunk === null || chunk === undefined) {
                this.__pushedEnd = true;
                this.emit('end');
                return false;
            }
            this.__buffer.push(chunk);
            this.emit('data', chunk);
            return true;
        }
        write(chunk, encodingOrCb, cb) {
            const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
            if (this.__writeImpl) this.__writeImpl(chunk, 'buffer', () => { if (callback) callback(); });
            else if (callback) callback();
            return true;
        }
        end(chunkOrCb, cb) {
            if (chunkOrCb && typeof chunkOrCb !== 'function') this.write(chunkOrCb);
            this.emit('finish');
            if (typeof chunkOrCb === 'function') chunkOrCb();
            else if (cb) cb();
            return this;
        }
        _read() {}
        on(name, fn) {
            super.on(name, fn);
            if (name === 'data' && this.__readImpl && !this.__reading) {
                this.__reading = true;
                this.__readImpl(16384);
            }
            return this;
        }
        pause() { return this; }
        resume() { return this; }
        pipe(dest) {
            this.on('data', chunk => dest.write(chunk));
            this.on('end', () => { if (dest.end) dest.end(); });
            return dest;
        }
        destroy(err) {
            this.destroyed = true;
            this.emit('close');
            if (err) this.emit('error', err);
        }
    }

    class Transform extends Duplex {
        constructor(options) {
            super(options);
            this.__transformImpl = options && options.transform;
            this.__flushImpl = options && options.flush;
        }
        write(chunk, encodingOrCb, cb) {
            const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
            if (this.__transformImpl) {
                this.__transformImpl(chunk, 'buffer', (err, out) => {
                    if (err) { this.emit('error', err); }
                    else if (out !== undefined && out !== null) this.push(out);
                    if (callback) callback();
                });
            } else {
                this.push(chunk);
                if (callback) callback();
            }
            return true;
        }
        end(chunkOrCb, cb) {
            if (chunkOrCb && typeof chunkOrCb !== 'function') this.write(chunkOrCb);
            const done = () => {
                if (this.__flushImpl) {
                    this.__flushImpl(cb2 => {
                        this.emit('end');
                        if (typeof chunkOrCb === 'function') chunkOrCb();
                        else if (cb) cb();
                    });
                } else {
                    this.emit('end');
                    if (typeof chunkOrCb === 'function') chunkOrCb();
                    else if (cb) cb();
                }
            };
            Promise.resolve().then(done);
            return this;
        }
    }

    class PassThrough extends Transform {
        constructor(options) {
            super(options);
            this.__transformImpl = (chunk, _enc, cb) => cb(null, chunk);
        }
    }

    /*
     * pipeline(...streams, callback): pumps chunks from the first stream
     * through each subsequent stage into the final writable.
     */
    const pipeline = (...args) => {
        const callback = typeof args[args.length - 1] === 'function' ? args.pop() : () => undefined;
        const [first, ...rest] = args;
        let current = first;
        let prev = first;
        for (const stage of rest) {
            if (prev !== first || current !== first) { /* chained below */ }
            prev = current;
            current = stage;
        }
        // chain every stage onto the previous one
        let chain = first;
        for (const stage of rest) {
            chain = chain.pipe(stage);
        }
        const last = rest.length > 0 ? rest[rest.length - 1] : first;
        let failed = false;
        const fail = err => {
            if (failed) return;
            failed = true;
            callback(err);
        };
        const list = [first, ...rest];
        list.forEach(s => {
            if (s && s.on) {
                s.on('error', fail);
            }
        });
        if (last === first) {
            // single readable: just let it flow to the end
            last.on('data', () => undefined);
            last.on('end', () => callback());
            last.on('close', () => { if (!failed && !last.__endedEmitted) callback(); });
            if (last.resume) last.resume();
            else if (last.__pump) last.__pump();
        }
        return last;
    };

    const finished = (stream, cb) => {
        const callback = typeof cb === 'function' ? cb : () => undefined;
        stream.on('finish', () => callback());
        stream.on('end', () => callback());
        stream.on('error', err => callback(err));
    };

    const Stream = class extends EE {
        pipe(dest) { return this; }
    };

    window.__streamShimModule = {
        Readable, Writable, Duplex, Transform, PassThrough, pipeline, finished, Stream,
        // passthrough for stream/promises import style
        promises: { pipeline, finished },
        _isArray: Array.isArray,
        _isUint8Array: v => v instanceof Uint8Array,
    };
    // 'stream/promises' import style: require('stream/promises')
    window.__streamPromisesShimModule = { pipeline, finished };
    window.__streamClasses = { Readable, Writable, Duplex, Transform, PassThrough, pipeline };
})();
