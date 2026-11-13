/*
 * Browser-side globals the bundle expects from an Electron renderer:
 * `process`, `global`, and a minimal `crypto` shim for Web Crypto.
 */
(function () {
    'use strict';

    window.global = window;

    /* crypto: node crypto surface used by bundled libraries */
    const proc = {
        env: { NODE_ENV: 'production' },
        platform: 'linux',
        arch: 'x64',
        version: 'v22.0.0',
        versions: { node: '22.0.0', chrome: 'web', electron: '0' },
        argv: ['nrfconnect', 'power-profiler'],
        pid: 1,
        ppid: 0,
        cwd: () => '/app',
        chdir: () => undefined,
        exit: () => { throw new Error('process.exit() called in browser build'); },
        kill: () => true,
        nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)),
        hrtime: {
            bigint: () => BigInt(Math.round(performance.now() * 1e6)),
        },
        umask: () => 0o022,
        memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0 }),
        uptime: () => performance.now() / 1000,
        stdin: null,
        stdout: { write: line => { console.log(line); return true; }, isTTY: false },
        stderr: { write: line => { console.error(line); return true; }, isTTY: false },
        binding: name => {
            // applicationinsights enumerates the builtin module names once
            if (name === 'natives') {
                return {
                    fs: '', path: '', util: '', events: '', stream: '', os: '',
                    url: '', http: '', https: '', net: '', tls: '', zlib: '',
                    buffer: '', child_process: '', crypto: '', dns: '',
                    string_decoder: '', timers: '', assert: '', constants: '',
                    async_hooks: '', module: '', process: '', v8: '',
                };
            }
            throw new Error(`process.binding('${name}') not available in the browser build`);
        },
        dlopen: () => { throw new Error('native modules are not available in the browser build'); },
        features: {},
        config: {},
        release: { name: 'node' },
        connected: false,
        disconnect: () => undefined,
        on: () => proc,
        off: () => proc,
        once: () => proc,
        emit: () => false,
        addListener: () => proc,
        removeListener: () => proc,
        listeners: () => [],
        browser: true,
        noDeprecation: false,
    };

    window.process = proc;

    // crypto: node crypto surface used by bundled libraries
    window.__cryptoShim = {
        webcrypto: window.crypto,
        getRandomValues: a => window.crypto.getRandomValues(a),
        randomBytes: n => {
            const out = new Uint8Array(n);
            window.crypto.getRandomValues(out);
            return window.__nodeBuffer ? window.__nodeBuffer.from(out) : out;
        },
        randomUUID: () => window.crypto.randomUUID(),
        createHash: name => {
            if (name !== 'sha256' && name !== 'sha1' && name !== 'md5') {
                throw new Error(`Unsupported hash algorithm ${name}`);
            }
            const algo = name === 'sha256' ? 'SHA-256' : name === 'sha1' ? 'SHA-1' : 'MD5';
            const chunks = [];
            return {
                update(data) {
                    chunks.push(data instanceof Uint8Array ? data : new TextEncoder().encode(String(data)));
                    return this;
                },
                digest: (encoding) => {
                    // webcrypto is async; feed back zeros for sync callers.
                    // Only used by telemetry paths (blocked) and DFU (unsupported).
                    const digest = new Uint8Array(algo === 'MD5' ? 16 : algo === 'SHA-1' ? 20 : 32);
                    crypto.subtle.digest(algo, concat(chunks)).then(
                        r => digest.set(new Uint8Array(r)),
                        () => undefined,
                    );
                    const buf = window.__nodeBuffer ? window.__nodeBuffer.from(digest) : digest;
                    if (encoding === 'hex') return buf.toString('hex');
                    return buf;
                },
            };
        },
        createHmac: () => ({ update() { return this; }, digest: () => new Uint8Array(32) }),
        scryptSync: () => new Uint8Array(32),
        pbkdf2Sync: () => new Uint8Array(32),
    };

    function concat(chunks) {
        const total = chunks.reduce((s, c) => s + c.byteLength, 0);
        const out = new Uint8Array(total);
        let o = 0;
        for (const c of chunks) { out.set(c, o); o += c.byteLength; }
        return out;
    }
})();
