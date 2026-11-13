/*
 * Small node builtin shims: os, util, timers, assert, url, constants,
 * async_hooks, dns, net, http(s), string_decoder and a tiny events re-export.
 * Only what the app and its bundled libraries touch at load time.
 */
(function () {
    'use strict';

    /* ---------------------------- os ---------------------------- */
    const os = {
        EOL: '\n',
        tmpdir: () => '/tmp',
        homedir: () => '/home/web',
        platform: () => 'linux',
        arch: () => 'x64',
        release: () => '6.6.0-web',
        hostname: () => 'web',
        type: () => 'Browser',
        cpus: () => [],
        userInfo: () => ({ username: 'web', homedir: '/home/web' }),
        totalmem: () => 4294967296,
        freemem: () => 2147483648,
        uptime: () => 0,
        loadavg: () => [0, 0, 0],
        endianness: () => 'LE',
    };
    window.__osShim = os;

    /* --------------------------- util --------------------------- */
    const inspect = value => {
        if (typeof value === 'string') return `'${value}'`;
        try {
            return JSON.stringify(value, (key, v) => (typeof v === 'bigint' ? `${v}` : v), 2);
        } catch (e) {
            return String(value);
        }
    };
    const format = (f, ...rest) => {
        if (typeof f !== 'string') {
            return [f, ...rest].map(inspect).join(' ');
        }
        let i = 0;
        const out = f.replace(/%[sdifjoO%]/g, m => {
            if (m === '%%') return '%';
            if (i >= rest.length) return m;
            const v = rest[i++];
            switch (m) {
                case '%s': return String(v);
                case '%d': case '%i': return Number(v);
                case '%f': return Number(v);
                case '%j': try { return JSON.stringify(v); } catch (e) { return '[Circular]'; }
                default: return inspect(v);
            }
        });
        const remaining = rest.slice(i);
        if (remaining.length > 0) {
            return `${out} ${remaining.map(inspect).join(' ')}`;
        }
        return out;
    };
    const util = {
        inspect,
        format,
        formatWithOptions: (opts, f, ...rest) => format(f, ...rest),
        inherits: (ctor, superCtor) => {
            Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
        },
        deprecate: fn => fn,
        promisify: original => {
            if (typeof original !== 'function') {
                // fs-extra reads .__promisified off the result even when the
                // wrapped fs fn is missing; keep that safe
                const stub = async () => undefined;
                stub.__promisified = stub;
                return stub;
            }
            if (original.__promisified) return original.__promisified;
            const promisified = (...args) =>
                new Promise((resolve, reject) => {
                    original(...args, (err, ...values) => {
                        if (err) reject(err);
                        else resolve(values[0]);
                    });
                });
            promisified.__promisified = promisified;
            promisified.custom = Symbol('util.promisify.custom');
            return promisified;
        },
        callbackify: fn => (...args) => {
            const cb = args.pop();
            fn(...args).then(
                value => cb(null, value),
                err => cb(err),
            );
        },
        types: new Proxy({}, { get: () => () => false }),
        TextEncoder: typeof TextEncoder !== 'undefined' ? TextEncoder : undefined,
        TextDecoder: typeof TextDecoder !== 'undefined' ? TextDecoder : undefined,
        debuglog: () => () => undefined,
        isDeepStrictEqual: (a, b) => JSON.stringify(a) === JSON.stringify(b),
        isArray: Array.isArray,
    };
    window.__utilShim = util;

    /* -------------------------- timers -------------------------- */
    window.__timersShim = {
        setTimeout, clearTimeout, setInterval, clearInterval, setImmediate: setTimeout, clearImmediate: clearTimeout,
    };

    /* -------------------------- assert -------------------------- */
    const assert = (value, message) => {
        if (!value) {
            throw new Error(message || 'Assertion failed');
        }
    };
    assert.ok = assert;
    assert.equal = (a, b, m) => { if (a != b) throw new Error(m || `${a} != ${b}`); };
    assert.strictEqual = (a, b, m) => { if (a !== b) throw new Error(m || `${a} !== ${b}`); };
    assert.deepEqual = assert.equal;
    assert.deepStrictEqual = assert.strictEqual;
    assert.notEqual = (a, b, m) => { if (a == b) throw new Error(m); };
    assert.notStrictEqual = (a, b, m) => { if (a === b) throw new Error(m); };
    assert.throws = (fn, _type) => { try { fn(); } catch (e) { return e; } throw new Error('Missing expected exception'); };
    assert.doesNotThrow = fn => fn();
    assert.fail = message => { throw new Error(message); };
    assert.strict = { ok: assert, equal: assert.strictEqual, strictEqual: assert.strictEqual };
    window.__assertShim = assert;

    /* ---------------------------- url ---------------------------- */
    window.__urlShim = {
        URL, URLSearchParams,
        parse: urlStr => {
            try {
                const u = new URL(urlStr, window.location.href);
                return {
                    href: u.href, protocol: u.protocol, host: u.host, hostname: u.hostname,
                    port: u.port, pathname: u.pathname, search: u.search, hash: u.hash,
                    auth: '', slashes: true, path: u.pathname + u.search, query: u.search,
                };
            } catch (e) {
                return { href: urlStr, path: urlStr, pathname: urlStr, query: {} };
            }
        },
        format: u => (typeof u === 'string' ? u : u.href || `${u.protocol || ''}//${u.host || ''}${u.path || ''}`),
        resolve: (from, to) => new URL(to, new URL(from, window.location.href)).href,
        fileURLToPath: u => (typeof u === 'string' ? u.replace(/^file:\/\//, '') : u.pathname),
        pathToFileURL: p => new URL(`file://${p}`),
    };

    /* ------------------------- constants ------------------------ */
    window.__constantsShim = { EOK: 0, F_OK: 0, R_OK: 4, W_OK: 2, SIGTERM: 15, SIGINT: 2, SIGKILL: 9 };

    /* ------------------------ async_hooks ----------------------- */
    window.__asyncHooksShim = {
        AsyncLocalStorage: class { enterWith() {} run(store, cb) { return cb(); } getStore() { return undefined; } },
        AsyncResource: class { constructor() {} runInAsyncScope(fn) { return fn(); } bind(fn) { return fn; } },
        createHook: () => ({ enable() {}, disable() {} }),
        executionAsyncId: () => 0,
        executionAsyncResource: () => ({}),
        triggerAsyncId: () => 0,
    };

    /* ---------------------------- dns --------------------------- */
    const dnsLookup = (host, options, callback) => {
        const cb = typeof options === 'function' ? options : callback;
        if (cb) cb(null, { address: '127.0.0.1', family: 4 });
        return {};
    };
    window.__dnsShim = {
        lookup: dnsLookup,
        resolve: (host, cb) => { if (cb) cb(null, ['127.0.0.1']); },
        resolve4: (host, cb) => { if (cb) cb(null, ['127.0.0.1']); },
        promises: { lookup: async (host, options) => ({ address: '127.0.0.1', family: 4 }) },
    };

    /* --------------------------- net ---------------------------- */
    class NetSocket extends window.__eventsShim {
        constructor() { super(); }
        connect() { return this; }
        write() { return false; }
        end() {}
        destroy() {}
        setTimeout() { return this; }
    }
    window.__netShim = {
        Socket: NetSocket,
        connect: () => new NetSocket(),
        createConnection: () => new NetSocket(),
        createServer: () => ({ listen() {}, close() {}, on() {} }),
        isIP: () => 4,
    };

    /* ------------------------- http(s) -------------------------- */
    const fakeAgent = () => ({ defaultPort: 443, protocol: 'https:' });
    const httpStub = {
        Agent: class { constructor() {} destroy() {} },
        request: () => ({ on() { return this; }, end() {}, write() {}, destroy() {}, setTimeout() {} }),
        get: () => ({ on() { return this; }, end() {}, destroy() {} }),
        createServer: () => ({ listen() {}, close() {}, on() {} }),
        globalAgent: { defaultPort: 443 },
        STATUS_CODES: { 200: 'OK' },
        validateHeaderName: () => undefined,
        validateHeaderValue: () => undefined,
        setMaxListeners: () => undefined,
        IncomingMessage: class {},
        ServerResponse: class {},
    };
    window.__httpShim = httpStub;
    window.__httpsShim = { ...httpStub, globalAgent: { defaultPort: 443 } };

    /* ----------------------- string_decoder --------------------- */
    class StringDecoder {
        constructor(encoding) { this.encoding = encoding || 'utf8'; }
        write(buf) { return window.__nodeBuffer.isBuffer(buf) ? buf.toString(this.encoding) : String(buf); }
        end(buf) { return buf ? this.write(buf) : ''; }
    }
    window.__stringDecoderShim = StringDecoder;
    window.__stringDecoderShimModule = { StringDecoder };

    /* -------------------------- module -------------------------- */
    window.__moduleShim = {
        createRequire: () => window.require,
        builtinModules: [],
        paths: [],
    };

    /* -------------------------- console ------------------------- */
    window.__consoleShim = console;

    /* --------------------- original-fs alias -------------------- */
    // resolved after fs.js has run
    window.__bindOriginalFs = () => { window.__originalFsShim = window.__fsShim; };
})();
