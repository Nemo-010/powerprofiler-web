/*
 * Virtual file system backing the `fs` shim.
 *
 * The upstream app reads and writes plain files (config store, session
 * buffers, nrfutil sandbox paths). In the browser this is an in-memory map,
 * optionally persisted to localStorage for the config store, and bridged to
 * the File System Access API through `/picked/...` entries.
 */
(function () {
    'use strict';

    const backingFiles = new Map(); // path -> { data: Uint8Array | File }
    let listeners = [];

    const encode = value => {
        if (value instanceof Uint8Array) return value;
        if (value instanceof ArrayBuffer) return new Uint8Array(value);
        if (typeof value === 'string') return new TextEncoder().encode(value);
        if (value && value.buffer instanceof ArrayBuffer) {
            return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        }
        return new TextEncoder().encode(String(value));
    };

    const LS_PREFIX = 'ppkweb:vfs:';
    const isPersistent = path => path === '/config/config.json';

    const persist = path => {
        if (!isPersistent(path)) return;
        try {
            const entry = backingFiles.get(path);
            if (!entry) {
                localStorage.removeItem(LS_PREFIX + path);
            } else if (entry.data instanceof Uint8Array) {
                localStorage.setItem(LS_PREFIX + path, String.fromCharCode(...entry.data.subarray(0, 200000)));
                // note: binary-safe enough for the JSON config, which is text
            }
        } catch (e) {
            /* storage full or unavailable: keep memory copy */
        }
    };

    const restore = () => {
        try {
            for (let i = 0; i < localStorage.length; i += 1) {
                const key = localStorage.key(i);
                if (key && key.startsWith(LS_PREFIX)) {
                    const path = key.slice(LS_PREFIX.length);
                    const raw = localStorage.getItem(key);
                    backingFiles.set(path, {
                        data: new TextEncoder().encode(raw),
                    });
                }
            }
        } catch (e) {
            /* no localStorage */
        }
    };

    const vfs = {
        // true when the path exists or is one of the paths we fake as existing
        // (the nrfutil sandbox pretends its binaries are installed so that the
        // app never tries to download them)
        exists(path) {
            if (typeof path !== 'string') return false;
            return (
                backingFiles.has(path) ||
                path.includes('nrfutil-sandboxes') ||
                path === '/data/nrfutil' ||
                path.startsWith('/data/nrfutil-sandboxes/')
            );
        },
        isFile(path) {
            return backingFiles.has(path) && backingFiles.get(path).data instanceof Uint8Array || (backingFiles.has(path) && backingFiles.get(path).data instanceof File);
        },
        readFile(path) {
            const entry = backingFiles.get(path);
            if (!entry) {
                const err = new Error(`ENOENT: no such file or directory, open '${path}'`);
                err.code = 'ENOENT';
                throw err;
            }
            return entry.data;
        },
        writeFile(path, data) {
            backingFiles.set(path, { data: encode(data) });
            persist(path);
        },
        appendFile(path, data) {
            const current = backingFiles.get(path);
            const addition = encode(data);
            if (current && current.data instanceof Uint8Array) {
                const merged = new Uint8Array(current.data.length + addition.length);
                merged.set(current.data, 0);
                merged.set(addition, current.data.length);
                backingFiles.set(path, { data: merged });
            } else {
                backingFiles.set(path, { data: addition });
            }
            persist(path);
        },
        remove(path) {
            backingFiles.delete(path);
            if (isPersistent(path)) {
                try {
                    localStorage.removeItem(LS_PREFIX + path);
                } catch (e) { /* ignore */ }
            }
        },
        rename(from, to) {
            if (!backingFiles.has(from)) {
                const err = new Error(`ENOENT: no such file or directory, rename '${from}'`);
                err.code = 'ENOENT';
                throw err;
            }
            backingFiles.set(to, backingFiles.get(from));
            backingFiles.delete(from);
            persist(to);
        },
        size(path) {
            const entry = backingFiles.get(path);
            if (!entry) return 0;
            if (entry.data instanceof Uint8Array) return entry.data.byteLength;
            if (entry.data instanceof File) return entry.data.size;
            return 0;
        },
        // register a File System Access handle under /picked/<name>
        registerPicked(name, handle, file) {
            const path = `/picked/${name}`;
            backingFiles.set(path, { data: file, handle });
            return path;
        },
        getPickedHandle(path) {
            const entry = backingFiles.get(path);
            return entry ? entry.handle : undefined;
        },
        dirs: new Set(['/config', '/tmp']),
        mkdir(path) {
            if (typeof path === 'string') {
                this.dirs.add(path);
                backingFiles.set(path, { data: new Uint8Array(0), dir: true });
            }
        },
        readdir(path) {
            const names = [];
            for (const [p, entry] of backingFiles.entries()) {
                if (entry.dir || p.endsWith('/')) continue;
                const parent = p.slice(0, p.lastIndexOf('/')) || '/';
                if (parent === path) names.push(p.slice(p.lastIndexOf('/') + 1));
            }
            return names;
        },
        reset() {
            backingFiles.clear();
        },
        restore,
    };

    window.__vfs = vfs;
})();
