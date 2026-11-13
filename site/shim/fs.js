/*
 * `fs` shim. Only the APIs the app actually exercises are implemented; the
 * virtual file system in vfs.js provides storage, and writes to `/picked/...`
 * paths are forwarded to handles obtained through the File System Access API.
 */
(function () {
    'use strict';

    const vfs = window.__vfs;

    class FSError extends Error {
        constructor(code, message) {
            super(`${code}: ${message}`);
            this.code = code;
        }
    }

    const notImplemented = name => () => {
        throw new FSError('ENOSYS', `fs.${name} is not implemented in the browser build`);
    };

    /* ------------------------------------------------------------------ *
     * Write streams
     * ------------------------------------------------------------------ */

    class WriteStream {
        constructor(path) {
            this.path = path;
            this.writable = true;
            this.destroyed = false;
            this.__chunks = [];
            this.__events = { error: [], finish: [], close: [], open: [] };
            const handle = vfs.getPickedHandle(path);
            this.__handle = handle;
            this.__fileWritable = null;
            // defer: callers attach 'error'/'finish' listeners after creation
            if (handle) {
                handle.createWritable().then(
                    writable => {
                        this.__fileWritable = writable;
                        this.__emit('open');
                    },
                    err => this.__emit('error', err),
                );
            }
        }
        __emit(name, arg) {
            (this.__events[name] || []).forEach(fn => fn(arg));
        }
        on(name, fn) {
            (this.__events[name] = this.__events[name] || []).push(fn);
            if (name === 'open') {
                // node emits 'open' immediately for already-opened streams
                setTimeout(() => this.__emit('open'), 0);
            }
            return this;
        }
        once(name, fn) {
            const wrapped = arg => {
                this.off(name, wrapped);
                fn(arg);
            };
            this.on(name, wrapped);
            return this;
        }
        off(name, fn) {
            this.__events[name] = (this.__events[name] || []).filter(f => f !== fn);
            return this;
        }
        addListener(name, fn) { return this.on(name, fn); }
        removeListener(name, fn) { return this.off(name, fn); }
        emit(name, arg) { this.__emit(name, arg); return true; }
        async __writeChunk(chunk) {
            if (this.__fileWritable) {
                await this.__fileWritable.write(window.__nodeBuffer.isBuffer(chunk) ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength) : chunk);
            } else {
                this.__chunks.push(chunk);
            }
        }
        write(chunk, encodingOrCb, cb) {
            const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
            this.__writeChunk(chunk).then(
                () => { if (callback) callback(null); },
                err => {
                    this.__emit('error', err);
                    if (callback) callback(err);
                },
            );
            return true;
        }
        end(chunk, cb) {
            const done = async () => {
                this.destroyed = true;
                if (this.__fileWritable) {
                    try {
                        await this.__fileWritable.close();
                    } catch (err) {
                        this.__emit('error', err);
                    }
                } else if (this.__chunks.length > 0 || !this.__handle) {
                    // materialise collected chunks into the virtual fs
                    const parts = this.__chunks.map(c => (window.__nodeBuffer.isBuffer(c) ? new Uint8Array(c.buffer, c.byteOffset, c.byteLength) : window.__vfsEncode ? window.__vfsEncode(c) : new TextEncoder().encode(String(c))));
                    let total = 0;
                    parts.forEach(p => { total += p.byteLength; });
                    const merged = new Uint8Array(total);
                    let offset = 0;
                    parts.forEach(p => { merged.set(p, offset); offset += p.byteLength; });
                    window.__vfs.writeFile(this.path, merged);
                }
                this.__emit('finish');
                this.__emit('close');
                if (typeof chunk === 'function') chunk();
                else if (cb) cb();
            };
            if (chunk && typeof chunk !== 'function') this.write(chunk);
            // small delay so that piped data has been queued
            setTimeout(() => { done(); }, 0);
            return this;
        }
        close(cb) {
            if (!this.destroyed) this.end(cb);
            else if (cb) cb();
        }
        destroy() { this.destroyed = true; }
    }

    /* ------------------------------------------------------------------ *
     * Read streams (simple async iterator based pump)
     * ------------------------------------------------------------------ */

    class ReadStream {
        constructor(path, options) {
            this.path = path;
            this.readable = true;
            this.destroyed = false;
            this.__events = { data: [], end: [], error: [], close: [] };
            this.__pos = options && options.start ? options.start : 0;
            this.__paused = false;
            const entry = window.__vfs.readFile(path);
            if (entry instanceof Uint8Array) {
                this.__data = entry;
                this.__file = null;
            } else {
                this.__file = entry;
                this.__data = null;
            }
            this.__flowing = false;
            // node streams start flowing on pipe/data/resume
            setTimeout(() => { if (!this.__flowing) this.resume(); }, 0);
        }
        on(name, fn) {
            (this.__events[name] = this.__events[name] || []).push(fn);
            if (name === 'data') this.resume();
            return this;
        }
        once(name, fn) {
            const wrapped = arg => {
                this.off(name, wrapped);
                fn(arg);
            };
            this.on(name, wrapped);
            return this;
        }
        off(name, fn) {
            this.__events[name] = (this.__events[name] || []).filter(f => f !== fn);
            return this;
        }
        removeListener(name, fn) { return this.off(name, fn); }
        addListener(name, fn) { return this.on(name, fn); }
        pause() { this.__paused = true; return this; }
        resume() {
            if (this.__flowing) return this;
            this.__flowing = true;
            this.__pump();
            return this;
        }
        pipe(dest) {
            if (dest.__writableSink) {
                dest.__source = this;
                return dest;
            }
            this.on('data', chunk => {
                if (dest.write) dest.write(chunk);
            });
            this.on('end', () => { if (dest.end) dest.end(); });
            this.on('error', err => { if (dest.emit) dest.emit('error', err); });
            if (dest.emit) dest.emit('pipe', this);
            return dest;
        }
        async __pump() {
            const CHUNK = 256 * 1024;
            try {
                if (this.__file) {
                    let remaining = this.__file.size;
                    while (remaining > 0) {
                        const take = Math.min(CHUNK, remaining);
                        const buf = await this.__file.slice(this.__pos, this.__pos + take).arrayBuffer();
                        this.__emit('data', window.__nodeBuffer.from(buf));
                        this.__pos += take;
                        remaining -= take;
                        while (this.__paused && !this.destroyed) {
                            await new Promise(r => { setTimeout(r, 20); });
                        }
                        if (this.destroyed) return;
                    }
                } else {
                    while (this.__pos < this.__data.byteLength) {
                        const take = Math.min(CHUNK, this.__data.byteLength - this.__pos);
                        const sub = this.__data.subarray(this.__pos, this.__pos + take);
                        this.__emit('data', window.__nodeBuffer.from(sub));
                        this.__pos += take;
                        while (this.__paused && !this.destroyed) {
                            await new Promise(r => { setTimeout(r, 20); });
                        }
                        if (this.destroyed) return;
                    }
                }
                this.__emit('end');
                this.__emit('close');
            } catch (err) {
                this.__emit('error', err);
            }
        }
        __emit(name, arg) {
            (this.__events[name] || []).forEach(fn => fn(arg));
        }
        destroy() { this.destroyed = true; }
    }

    /* ------------------------------------------------------------------ *
     * Public fs object
     * ------------------------------------------------------------------ */

    const fs = {
        constants: { F_OK: 0, R_OK: 4, W_OK: 2 },
        existsSync: path => vfs.exists(path),
        mkdirSync: path => { vfs.mkdir(path); return undefined; },
        mkdir: (path, opts, cb) => { vfs.mkdir(path); if (typeof opts === 'function') opts(); else if (cb) cb(); return Promise.resolve(); },
        writeFileSync: (path, data) => { vfs.writeFile(path, data); },
        readFileSync: (path, encoding) => {
            const data = window.__nodeBuffer.from(vfs.readFile(path));
            return encoding ? data.toString(encoding) : data;
        },
        appendFileSync: (path, data) => { vfs.appendFile(path, data); },
        rmSync: (path, options) => { vfs.remove(path); },
        unlinkSync: path => { vfs.remove(path); },
        renameSync: (from, to) => { vfs.rename(from, to); },
        statSync: path => ({
            size: vfs.size(path),
            isFile: () => vfs.isFile(path),
            isDirectory: () => !vfs.isFile(path),
            mtime: new Date(),
            birthtime: new Date(),
        }),
        readdirSync: path => vfs.readdir(path),
        rmdirSync: path => { vfs.remove(path); },
        copyFileSync: (from, to) => { vfs.writeFile(to, vfs.readFile(from)); },
        createWriteStream: path => new WriteStream(path),
        createReadStream: (path, options) => new ReadStream(path, options),
        promises: {
            appendFile: async (path, data) => { vfs.appendFile(path, data); },
            writeFile: async (path, data) => { vfs.writeFile(path, data); },
            readFile: async (path, encoding) => fs.readFileSync(path, encoding),
            stat: async path => fs.statSync(path),
            mkdir: async path => { vfs.mkdir(path); },
            rm: async (path, options) => { vfs.remove(path); },
            unlink: async path => { vfs.remove(path); },
            readdir: async path => vfs.readdir(path),
            copyFile: async (from, to) => { vfs.writeFile(to, vfs.readFile(from)); },
            rename: async (from, to) => { vfs.rename(from, to); },
            chmod: async () => undefined,
            chown: async () => undefined,
            close: async () => undefined,
            fsync: async () => undefined,
            fdatasync: async () => undefined,
            truncate: async () => undefined,
            utimes: async () => undefined,
            lchown: async () => undefined,
            lchmod: async () => undefined,
            lutimes: async () => undefined,
            link: async () => undefined,
            symlink: async () => undefined,
            readlink: async path => path,
            realpath: async path => path,
            rmdir: async path => { vfs.remove(path); },
            mkdtemp: async prefix => `${prefix}${Date.now()}`,
            open: async (path, flags) => fs.openSync(path, flags),
            write: async (fd, data) => fs.writeSync(fd, data),
            read: async (fd, buffer) => fs.readSync(fd, buffer),
            lstat: async path => fs.statSync(path),
            fstat: async fd => fs.statSync(fdTable.get(fd).path),
        },
        // graceful-fs (bundled into the app) patches these if present
        MAX_OPEN_FILES: Infinity,
        gracefulify: self => self,
    };

    fs.accessSync = path => {
        if (!vfs.exists(path)) throw new FSError('ENOENT', `no such file or directory, access '${path}'`);
    };
    fs.access = (path, mode, cb) => {
        const done = typeof mode === 'function' ? mode : cb;
        if (vfs.exists(path)) { if (done) done(); return Promise.resolve(); }
        const err = new FSError('ENOENT', `no such file or directory, access '${path}'`);
        if (done) done(err);
        return Promise.reject(err);
    };

    /*
     * fs-extra (bundled) promisifies a long list of fs callbacks at load
     * time, so every one of them must exist as a function. Callback style:
     * succeed when the path exists (or when uninterested), else ENOENT.
     */
    const cbCall = (path, cb, wantExists) => {
        const ok = wantExists === undefined ? true : (wantExists ? vfs.exists(path) : !vfs.exists(path));
        if (cb) setTimeout(() => cb(ok ? null : new FSError('ENOENT', `no such file or directory, ${path}`)), 0);
    };
    const simpleCbs = {
        chmod: true, chown: true, close: true, fsync: true, fdatasync: true,
        truncate: true, utimes: true, link: true, symlink: true, unlink: false,
        rmdir: true, rename: true, copyFile: true, mkdtemp: true,
    };
    for (const [name, wantExists] of Object.entries(simpleCbs)) {
        fs[name] = (a, b, cb) => {
            const callback = typeof cb === 'function' ? cb : (typeof b === 'function' ? b : undefined);
            cbCall(a, callback, wantExists);
            if (!callback) return Promise.resolve();
        };
    }
    fs.open = (path, flags, mode, cb) => {
        const callback = typeof mode === 'function' ? mode : cb;
        if (callback) cbCall(path, err => callback(err, err ? undefined : 1), vfs.exists(path));
    };
    fs.read = (fd, buffer, offset, length, position, cb) => { if (cb) cb(null, 0, buffer); };
    fs.write = (fd, buffer, offset, length, position, cb) => {
        const callback = typeof position === 'function' ? position : cb;
        if (callback) callback(null, length, buffer);
    };
    fs.readFile = (path, encoding, cb) => {
        const callback = typeof encoding === 'function' ? encoding : cb;
        try {
            const data = fs.readFileSync(path, typeof encoding === 'string' ? encoding : undefined);
            if (callback) callback(null, data);
        } catch (err) {
            if (callback) callback(err);
            else return Promise.reject(err);
        }
    };
    fs.writeFile = (path, data, cb) => {
        try {
            vfs.writeFile(path, data);
            if (typeof cb === 'function') cb(null);
        } catch (err) {
            if (typeof cb === 'function') cb(err);
            else return Promise.reject(err);
        }
    };
    fs.readdir = (path, opts, cb) => {
        const callback = typeof opts === 'function' ? opts : cb;
        try {
            const names = vfs.readdir(path);
            if (callback) callback(null, names);
        } catch (err) {
            if (callback) callback(err);
            else return Promise.reject(err);
        }
    };
    fs.stat = (path, cb) => {
        if (!vfs.exists(path)) {
            const err = new FSError('ENOENT', `no such file or directory, stat '${path}'`);
            if (typeof cb === 'function') cb(err);
            else return Promise.reject(err);
        } else if (typeof cb === 'function') cb(null, fs.statSync(path));
    };
    fs.lstat = fs.stat;
    fs.fstat = (fd, cb) => { if (cb) cb(null, fs.statSync('/tmp')); };
    fs.realpath = (path, opts, cb) => {
        const callback = typeof opts === 'function' ? opts : cb;
        if (callback) cbCall(path, err => callback(err, err ? undefined : path), vfs.exists(path));
    };
    fs.realpathSync = path => path;
    fs.exists = (path, cb) => { if (cb) cb(vfs.exists(path)); };
    fs.createWriteStream.__shim = true;
    fs.lchown = fs.chown;
    fs.lchmod = fs.chmod;
    fs.lutimes = fs.utimes;
    fs.unwatchFile = () => undefined;
    fs.watchFile = () => ({ close() {} });
    fs.watch = () => ({ close() {}, on() {} });
    fs.curdir = '.';

    /*
     * fd table for openSync/readSync/writeSync: write-file-atomic (bundled,
     * used by the config store) opens a temp file, writes, fsyncs, closes
     * and renames. Implemented over the vfs.
     */
    const fdTable = new Map(); // fd -> {path, chunks, write}
    let nextFd = 100;
    const WRITABLE_FLAGS = /w|a|\+/;
    fs.openSync = (path, flags) => {
        const fd = nextFd;
        nextFd += 1;
        fdTable.set(fd, { path, chunks: [], write: WRITABLE_FLAGS.test(flags || 'r') });
        return fd;
    };
    fs.closeSync = fd => {
        const entry = fdTable.get(fd);
        if (entry && entry.write && entry.chunks.length > 0) {
            const total = entry.chunks.reduce((s, c) => s + c.length, 0);
            const merged = new Uint8Array(total);
            let off = 0;
            for (const c of entry.chunks) { merged.set(c, off); off += c.length; }
            vfs.writeFile(entry.path, merged);
        }
        fdTable.delete(fd);
    };
    fs.fsyncSync = () => undefined;
    fs.fdatasyncSync = () => undefined;
    fs.writeSync = (fd, data) => {
        const entry = fdTable.get(fd);
        if (!entry) throw new FSError('EBADF', 'bad file descriptor');
        const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data.buffer || data);
        entry.chunks.push(bytes);
        return bytes.length;
    };
    fs.readSync = (fd, buffer) => {
        const entry = fdTable.get(fd);
        if (!entry) throw new FSError('EBADF', 'bad file descriptor');
        const data = vfs.readFile(entry.path);
        buffer.set(data.subarray(0, buffer.length));
        return Math.min(data.length, buffer.length);
    };
    fs.fstatSync = fd => fs.statSync(fdTable.get(fd).path);
    fs.futimesSync = () => undefined;
    fs.chmodSync = () => undefined;
    fs.chownSync = () => undefined;
    fs.lchmodSync = () => undefined;
    fs.lchownSync = () => undefined;
    fs.lutimesSync = () => undefined;
    fs.truncateSync = () => undefined;
    fs.linkSync = () => undefined;
    fs.symlinkSync = () => undefined;
    fs.readlinkSync = path => path;
    fs.mkdtempSync = prefix => `${prefix}${Date.now()}`;
    fs.copyFileSync = (from, to) => { vfs.writeFile(to, vfs.readFile(from)); };

    fs.openSync.__isShim = true;

    window.__fsShim = fs;
})();
