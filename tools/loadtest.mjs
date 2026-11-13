/*
 * Node-based load test: executes the site's shim stack + the real app bundle
 * inside jsdom, reproducing what a browser would do on first paint. Catches
 * require-time and load-time breakage (missing shims, bad globals) without a
 * real browser. Render correctness is only verifiable in an actual browser.
 *
 * Usage: node tools/loadtest.mjs [--no-serial]
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { JSDOM } from '/tmp/oc-free/testdom/node_modules/jsdom/lib/api.js';

const here = dirname(fileURLToPath(import.meta.url));
const site = join(here, '..', 'site');
const require2 = createRequire(import.meta.url);
const t0 = Date.now();

const dom = new JSDOM('<!doctype html><html><head></head><body><div id="webapp"></div></body></html>', {
    url: 'https://example.org/',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
});

// async errors from timers/rejections: count instead of dumping megabytes
const errorCounts = new Map();
let errorOrdinal = 0;
const record = err => {
    const key = err && err.message || String(err);
    if (!errorCounts.has(key)) {
        errorOrdinal += 1;
        errorCounts.set(key, { count: 0, order: errorOrdinal, at: Date.now() - t0, stack: err && err.stack || '' });
    }
    errorCounts.get(key).count += 1;
};
process.on('uncaughtException', record);
process.on('unhandledRejection', record);

const { window } = dom;

// errors the app/boundary surfaces to window (React 18 re-throws effect errors)
window.addEventListener('error', event => {
    record(event.error || new Error(`window.onerror: ${event.message}`));
});

// ---- stub the WebSerial API (no hardware in CI) -----------------------
const fakePort = {
    getInfo: () => ({ usbVendorId: 0x1366, usbProductId: 0xc00a }),
    open: async () => {},
    close: async () => {},
    readable: {
        getReader: () => ({
            read: async () => ({ done: true, value: undefined }),
            cancel: async () => {},
            releaseLock: () => {},
        }),
    },
    writable: {
        getWriter: () => ({
            write: async () => {},
            releaseLock: () => {},
            close: async () => {},
        }),
    },
};
window.navigator.serial = {
    getPorts: async () => [fakePort],
    requestPort: async () => fakePort,
    addEventListener: () => {},
    removeEventListener: () => {},
};
window.navigator.wakeLock = {
    request: async () => ({ release: async () => {} }),
};
// jsdom lacks these; real browsers ship them
window.ResizeObserver = window.ResizeObserver || class {
    observe() {}
    unobserve() {}
    disconnect() {}
};
window.HTMLElement.prototype.scrollIntoView = window.HTMLElement.prototype.scrollIntoView || (() => {});
// jsdom has no canvas implementation; give Chart.js a fake 2d context so
// rendering completes (chart pixels are meaningless here, structure is not)
window.HTMLCanvasElement.prototype.getContext = function () {
    const canvas = this;
    const proxy = new Proxy({}, {
        get: (target, prop) => {
            if (prop === 'canvas') return canvas;
            if (prop === 'measureText') {
                return () => ({ width: 10, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 });
            }
            if (prop === 'getLineDash') return () => [];
            if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
                return () => ({ addColorStop: () => {} });
            }
            return () => proxy;
        },
        set: () => true,
    });
    return proxy;
};
window.IntersectionObserver = window.IntersectionObserver || class {
    observe() {}
    unobserve() {}
    disconnect() {}
};
// DecompressionStream used by the zlib shim
if (!window.DecompressionStream) {
    window.DecompressionStream = class {
        constructor(_format) {
            this.readable = null;
            this.writable = null;
        }
    };
}

// ---- execute shim scripts in DOM order -------------------------------
const scriptOrder = [
    'shim/globals.js',
    'shim/buffer.js',
    'shim/events.js',
    'shim/path.js',
    'shim/node-builtins.js',
    'shim/stream.js',
    'shim/vfs.js',
    'shim/zlib.js',
    'shim/fs.js',
    'shim/serial.js',
    'shim/serial-ipc.js',
    'shim/nrfutil.js',
    'shim/childproc.js',
    'shim/electron.js',
    'shim/archiver.js',
    'shim/require.js',
];

for (const script of scriptOrder) {
    const code = readFileSync(join(site, script), 'utf8');
    try {
        window.eval(code);
    } catch (err) {
        console.error(`SHIM FAILED: ${script}`);
        throw err;
    }
}
console.log('shims loaded OK');

// ---- run the real bundle ----------------------------------------------
const bundleCode = readFileSync(
    join(site, 'app', 'pc-nrfconnect-ppk-4.4.1', 'bundle.js'),
    'utf8',
);
try {
    window.eval(bundleCode);
} catch (err) {
    console.error('BUNDLE FAILED');
    console.error(err && err.stack || err);
    process.exit(1);
}
console.log(`bundle.js evaluated in ${Date.now() - t0} ms`);

// ---- let timers/microtasks settle ------------------------------------
// snapshot the UI as it settles, so we can see what rendered before any late crash
for (const delay of [50, 150, 300, 1000, 3000]) {
    await new Promise(r => setTimeout(r, delay === 1000 ? 1000 : 1000));
    const text = window.document.body.textContent || '';
    console.log(`t=${delay / 1000}s text length: ${text.length}, sample: ${text.replace(/\s+/g, ' ').slice(0, 120)}`);
}
await new Promise(r => setTimeout(r, 2000));

const root = window.document.getElementById('webapp');
const html = root.innerHTML;
console.log(`#webapp innerHTML length: ${html.length}`);
console.log('--- async error summary ---');
for (const [message, info] of errorCounts) {
    console.log(`#${info.order} @${info.at}ms ${info.count}x ${message}`);
    if (info.order <= 3) console.log(info.stack.split('\n').slice(0, 8).join('\n'));
}
if (html.length < 100) {
    console.error('APP DID NOT RENDER: #webapp is still empty');
    process.exit(1);
}
const text = window.document.body.textContent || '';
console.log('page text sample:', text.replace(/\s+/g, ' ').slice(0, 2500));
process.exit(0);
