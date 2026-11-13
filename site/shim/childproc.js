/*
 * `child_process` shim.
 *
 * - spawn() intercepts the nrfutil binary and runs the browser emulator.
 * - fork() reimplements the serial worker protocol (worker/serialDevice.js)
 *   on top of WebSerial: {open: path} in, {opening}/{started}/{error} out,
 *   and {type:'Buffer', data:[...]} messages batched every 30 ms.
 */
(function () {
    'use strict';

    const EE = window.__eventsShim;
    const serialManager = () => window.__serialManager;
    const spawnNrfutil = window.__nrfutilSpawn;

    /* ------------------------------------------------------------------ *
     * fork: serial worker over WebSerial
     * ------------------------------------------------------------------ */

    class SerialWorkerChild extends EE {
        constructor() {
            super();
            this.pid = Math.floor(Math.random() * 60000) + 1000;
            this.connected = true;
            this.exitCode = null;
            this.killed = false;
            this.stdout = new EE();
            this.stderr = new EE();
            this.stdio = [null, this.stdout, this.stderr];
            this.__serialKey = null;
            this.__openEntry = null;
        }

        send(message) {
            if (!this.connected) return false;
            if (message && message.open !== undefined) {
                this.__handleOpen(message.open);
            } else if (message && message.write !== undefined) {
                this.__handleWrite(message.write);
            } else if (message && message.close !== undefined) {
                this.kill();
            }
            return true;
        }

        async __handleOpen(path) {
            const key = this.__keyForPath(path);
            this.emit('message', { opening: path });
            try {
                await serialManager().open(key);
                const entry = serialManager().ports.get(key);
                entry.open.onData = buf => {
                    // node IPC JSON-serialises Buffers; the app's parser only
                    // accepts objects carrying a `data` array
                    this.emit('message', { type: 'Buffer', data: [...buf] });
                };
                entry.open.onError = err => {
                    this.emit('message', { error: String(err && err.message || err) });
                };
                entry.open.onClose = () => {
                    this.__onPortClosed();
                };
                this.__serialKey = key;
                this.__openEntry = entry;
                this.emit('message', { started: path });
            } catch (err) {
                this.emit('message', { error: String(err && err.message || err) });
            }
        }

        __keyForPath(path) {
            // comPath form: /webserial/<key>
            if (typeof path === 'string' && path.startsWith('/webserial/')) {
                return path.slice('/webserial/'.length);
            }
            return null;
        }

        async __handleWrite(data) {
            try {
                const bytes = window.__nodeBuffer.isBuffer(data)
                    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
                    : new Uint8Array(data);
                await serialManager().write(this.__serialKey, bytes);
            } catch (err) {
                this.emit('message', { error: String(err && err.message || err) });
            }
        }

        __onPortClosed() {
            this.connected = false;
            this.exitCode = 0;
            setTimeout(() => this.emit('close', 0, null), 0);
        }

        kill() {
            if (this.killed) return true;
            this.killed = true;
            if (this.__serialKey) {
                serialManager().close(this.__serialKey);
            }
            this.connected = false;
            this.exitCode = 0;
            setTimeout(() => {
                this.emit('disconnect');
                this.emit('close', 0, null);
            }, 0);
            return true;
        }

        disconnect() { return this.connected = false; }
        unref() {}
        ref() {}
    }

    const fork = () => new SerialWorkerChild();

    /* ------------------------------------------------------------------ *
     * spawn: nrfutil only
     * ------------------------------------------------------------------ */

    class FakeSpawnedProcess extends EE {
        constructor(child) {
            super();
            this.pid = child.pid;
            this.killed = false;
            this.exitCode = null;
            this.stdout = child.stdout;
            this.stderr = child.stderr;
            this.stdin = { write: () => true, end: () => undefined };
            this.stdio = [null, this.stdout, this.stderr];
            this.__inner = child;
            child.on('close', (code, signal) => {
                this.exitCode = code;
                this.emit('close', code, signal);
            });
        }
        kill() { return this.__inner.kill(); }
        unref() {}
        ref() {}
    }

    const spawn = (cmd, args, options) => {
        const base = typeof cmd === 'string' ? cmd : '';
        if (base.endsWith('nrfutil')) {
            return new FakeSpawnedProcess(spawnNrfutil(cmd, args || []));
        }
        const errChild = new FakeSpawnedProcess({
            pid: 0,
            stdout: new EE(),
            stderr: new EE(),
            on: (name, fn) => { if (name === 'close' || name === 'error') setTimeout(() => fn(1, null), 0); },
            kill: () => true,
        });
        // surface a spawn failure for unknown binaries
        setTimeout(() => {
            errChild.stderr.emit('data', window.__nodeBuffer.from(`spawn ${cmd} ENOENT (browser build)`));
            errChild.exitCode = 1;
            errChild.emit('error', new Error(`spawn ${cmd} ENOENT`));
            errChild.emit('close', 1, null);
        }, 0);
        return errChild;
    };

    window.__childProcessShim = { spawn, fork, exec: () => undefined, execSync: () => '', execFile: () => undefined, spawnSync: () => ({ status: 1 }) };
})();
