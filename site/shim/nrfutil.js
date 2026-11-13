/*
 * nrfutil CLI emulator.
 *
 * The app shells out to a nrfutil binary for device enumeration, hotplug
 * events and module versions, parsing NDJSON on stdout. This emulates the
 * exact surface the app uses (nrfutil-device 2.10.2 protocol as documented in
 * NOTES.md), backed by the WebSerial manager instead of the OS.
 */
(function () {
    'use strict';

    const serialManager = () => window.__serialManager;

    const DEVICE_VERSION = '2.10.2';
    const CORE_VERSION = '8.1.1';

    const ModuleVersion = version => ({
        type: 'nrfutil',
        name: 'nrfutil-device',
        version,
        channel: 'official',
        description: 'nrfutil-device in the browser build',
        path: '/data/nrfutil',
    });

    const CoreModuleVersion = {
        type: 'nrfutil',
        name: 'nrfutil',
        version: CORE_VERSION,
        channel: 'official',
        description: 'nrfutil in the browser build (emulated core)',
        path: '/data/nrfutil',
    };

    const now = () => new Date().toISOString();

    const logLine = (level, message) => JSON.stringify({
        type: 'log',
        data: {
            local_time: now(),
            level,
            file: 'emulator',
            line: 0,
            module: 'emulator',
            message,
        },
    });

    const taskBegin = (name, description) => JSON.stringify({
        type: 'task_begin',
        data: { task: name, description: description || name },
    });

    const taskEnd = (name, data, result) => JSON.stringify({
        type: 'task_end',
        data: { task: name, result: result || 'success', ...(data !== undefined ? { data } : {}) },
    });

    // firmware version reported through the DFU trigger interface; matches
    // the firmware bundled with pc-nrfconnect-ppk 4.4.1 so that an
    // up-to-date PPK2 opens without a firmware-update dialog
    const PPK2_FW_SEMVER = 'power_profiler_kit_2 1.2.4-db16a94';

    const findDevice = serialNumber =>
        [...serialManager().ports.values()].find(e => e.serialNumber === serialNumber);

    const parseFlags = args => {
        const flags = { positional: [] };
        for (let i = 0; i < args.length; i += 1) {
            const arg = args[i];
            if (arg === '--traits') {
                flags.traits = (args[i + 1] || '').split(',').filter(Boolean);
                i += 1;
            } else if (arg === '--hotplug') {
                flags.hotplug = true;
            } else if (arg === '--timeout-ms') {
                flags.timeoutMs = parseInt(args[i + 1], 10) || 60000;
                i += 1;
            } else if (!arg.startsWith('--')) {
                flags.positional.push(arg);
            }
        }
        return flags;
    };

    const matchesTraits = (device, wanted) => {
        if (!wanted || wanted.length === 0) return true;
        return wanted.every(trait => trait === 'broken' ? !!device.broken : !!device.traits[trait]);
    };

    const mapSerialPorts = (ports, wantedTraits) => {
        const list = ports.map(entry => ({
            id: entry.key,
            serialNumber: entry.serialNumber,
            traits: {
                usb: true,
                nordicUsb: entry.info.usbVendorId === 0x1915,
                nordicDfu: entry.info.usbVendorId === 0x1915,
                seggerUsb: entry.info.usbVendorId === 0x1366,
                jlink: false,
                serialPorts: true,
                broken: false,
                mcuBoot: false,
                modem: false,
                boardController: false,
            },
            usb: {
                serialNumber: entry.serialNumber,
                manufacturer: 'Nordic Semiconductor',
                osDevicePath: entry.key,
                product: entry.info.product,
                device: {
                    busNumber: 1,
                    address: 1,
                    descriptor: {
                        bDescriptorType: 1,
                        idVendor: entry.info.usbVendorId,
                        idProduct: entry.info.usbProductId,
                        bcdDevice: 0x0100,
                    },
                    configList: { descriptors: [], interfaceLists: [], length: 1 },
                },
            },
            serialPorts: [{
                serialNumber: entry.serialNumber,
                comName: entry.comPath,
                manufacturer: 'Nordic Semiconductor',
                productId: entry.info.usbProductId.toString(16),
                vendorId: entry.info.usbVendorId.toString(16),
                vcom: 0,
                path: entry.comPath,
            }],
            broken: null,
        }));
        return list.filter(d => matchesTraits(d, wantedTraits));
    };

    class FakeChild {
        constructor() {
            this.pid = Math.floor(Math.random() * 60000) + 1000;
            this.killed = false;
            this.exitCode = null;
            this.stdout = new window.__eventsShim();
            this.stderr = new window.__eventsShim();
            this.__listeners = { close: [], error: [] };
            this.__unhotplug = null;
        }
        on(name, fn) {
            if (this.__listeners[name]) {
                this.__listeners[name].push(fn);
                // a child spawned before any data must still fire close later
                if (this.__closed && name === 'close') {
                    setTimeout(() => fn(this.__closeCode, null), 0);
                }
                return this;
            }
            return window.__eventsShim.prototype.on.call(this, name, fn);
        }
        once(name, fn) {
            const wrapped = arg => { this.off(name, wrapped); fn(arg); };
            return this.on(name, wrapped);
        }
        off(name, fn) {
            if (this.__listeners[name]) {
                this.__listeners[name] = this.__listeners[name].filter(f => f !== fn);
            }
            return this;
        }
        emit(name, ...args) {
            (this.__listeners[name] || []).forEach(fn => fn(...args));
            return true;
        }
        kill() {
            this.killed = true;
            if (this.__unhotplug) this.__unhotplug();
            if (this.exitCode === null) this.__finish(1);
            return true;
        }
        __writeStdout(line) {
            this.stdout.emit('data', window.__nodeBuffer.from(`${line}\n`));
        }
        __writeStderr(text) {
            this.stderr.emit('data', window.__nodeBuffer.from(text));
        }
        __finish(code) {
            if (this.__closed) return;
            this.__closed = true;
            this.__closeCode = code;
            this.exitCode = code;
            this.__writeStdout(JSON.stringify({ type: 'log', data: { level: 'debug', message: `Exit code: ${code}` } }));
            setTimeout(() => this.emit('close', code, null), 0);
        }
    }

    const runEmulator = (args, child) => {
        const flags = parseFlags(args);
        const positional = flags.positional;
        const head = args[0] && !args[0].startsWith('--') ? args[0] : '';

        // ---- core version: `nrfutil --version` (args = ['--version', ...log flags]) ----
        if (head === '--version' || args[0] === '--version') {
            child.__writeStdout(JSON.stringify({ type: 'info', data: { version: CORE_VERSION } }));
            child.__finish(0);
            return;
        }

        // ---- everything else requires the device module ----
        if (head === 'device' && (positional[1] === '--version' || args.includes('--version'))) {
            child.__writeStdout(JSON.stringify({ type: 'info', data: ModuleVersion(DEVICE_VERSION) }));
            child.__finish(0);
            return;
        }

        if (head === 'device' && positional[1] === 'list') {
            child.__writeStderr(logLine('trace', 'Running: device list'));
            child.__writeStderr(logLine('info', 'Querying device registry'));
            (async () => {
                const ports = [...serialManager().ports.values()];
                const devices = mapSerialPorts(ports, flags.traits);
                child.__writeStdout(JSON.stringify({ type: 'info', data: { devices } }));
                child.__writeStderr(logLine('trace', `Found ${devices.length} device(s)`));
                if (flags.hotplug) {
                    const onHotplug = (event, entry) => {
                        if (event === 'Arrived' && entry) {
                            const [device] = mapSerialPorts([entry], null);
                            child.__writeStdout(JSON.stringify({ type: 'info', data: { id: entry.key, event: 'Arrived', device } }));
                        } else if (event === 'Left' && entry) {
                            child.__writeStdout(JSON.stringify({ type: 'info', data: { id: entry.key, event: 'Left' } }));
                        }
                    };
                    serialManager().hotplugListeners.add(onHotplug);
                    child.__unhotplug = () => {
                        serialManager().hotplugListeners.delete(onHotplug);
                    };
                    // stays open until kill()
                } else {
                    child.__finish(0);
                }
            })();
            return;
        }

        if (head === 'device' && (positional[1] === 'device-info' || positional[1] === 'fw-info')) {
            const snIndex = args.indexOf('--serial-number');
            const sn = snIndex >= 0 ? args[snIndex + 1] : null;
            const entry = sn ? findDevice(sn) : null;
            if (!entry) {
                child.__writeStdout(JSON.stringify({
                    type: 'task_end',
                    data: { task: positional[1], result: 'fail', message: `No device with serial number ${sn}` },
                }));
                child.__finish(0);
                return;
            }
            if (positional[1] === 'device-info') {
                const isPpk2 = entry.info.usbVendorId === 0x1366 && entry.info.usbProductId === 0xC00A;
                child.__writeStdout(taskEnd('device-info', {
                    name: 'device-info',
                    ...(isPpk2 ? { dfuTriggerVersion: { semVer: PPK2_FW_SEMVER } } : {}),
                    supportedOptions: [],
                    mcuStateOptions: [],
                }));
            } else {
                child.__writeStdout(taskEnd('fw-info', {
                    name: 'fw-read-info',
                    bootloaderType: 'NRFDL_BOOTLOADER_TYPE_NONE',
                    imageInfoList: [],
                    serialNumber: sn,
                }));
            }
            child.__finish(0);
            return;
        }

        if (head === '--help' || head === '' || head === 'help') {
            child.__writeStdout('Usage: nrfutil <subcommand> ...');
            child.__finish(0);
            return;
        }

        // unsupported operations fail with a helpful task_end
        child.__writeStdout(taskBegin(head, head));
        child.__writeStderr(logLine('info', `nrfutil ${JSON.stringify(args.slice(0, 8))} is not supported in the browser build`));
        child.__writeStdout(JSON.stringify({
            type: 'task_end',
            data: {
                task: head,
                result: 'fail',
                message: 'This operation is not supported in the browser build. Use nrfutil on the command line instead.',
            },
        }));
        child.__finish(0);
    };

    window.__nrfutilSpawn = (cmd, args) => {
        const child = new FakeChild();
        // keep the version command synchronous-fast; others async
        setTimeout(() => runEmulator(args, child), 0);
        return child;
    };

    window.__nrfutilEmulator = {
        DEVICE_VERSION,
        CORE_VERSION,
        ModuleVersion,
        CoreModuleVersion,
    };
})();
