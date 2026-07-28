// ==UserScript==
// @name VM Download Probe
// @namespace https://github.com/courtneydax
// @author courtneydax
// @description Throwaway diagnostic for Violentmonkey's new browser-download API: does GM_download support nested paths and blob: URLs?
// @version 0.1
// @updateURL https://github.com/courtneydax/sc-postdl/raw/main/vm-download-probe.user.js
// @downloadURL https://github.com/courtneydax/sc-postdl/raw/main/vm-download-probe.user.js
// @match https://example.com/*
// @match https://example.org/*
// @grant GM_download
// @grant GM_info
// @connect *
// @run-at document-idle
// @inject-into page
// ==/UserScript==

/*
 * SETUP
 *   1. Install Violentmonkey >= 2.45.2. As of 2026-07-28 that is a GitHub prerelease only —
 *      the store builds (CWS 2.45.0 / AMO 2.41.0) do NOT have browser-download support.
 *   2. VM dashboard -> Settings -> Advanced -> tick "Use browser download API",
 *      then click "Grant permission" to grant the optional `downloads` permission.
 *      BOTH are required; missing either silently falls back to the old no-paths path.
 *   3. Open https://example.com/ and use the panel in the top-right.
 *   4. Also run the whole thing under Tampermonkey for a known-good baseline.
 *
 * WHAT WE'RE ASKING (in priority order)
 *   Q1  Does a PAGE-ORIGIN blob: URL survive GM_download at all? This is the decider — the
 *       main script's save path is GM_download({url: URL.createObjectURL(blob), name}).
 *       Watch the logged blob URL's origin prefix; that is the crux of the whole question.
 *   Q2  Does a nested `name` ("a/b c/file.txt") actually create subfolders?
 *   Q3  Does GM_info.downloadMode read "browser", and does it flip LIVE when you toggle the
 *       VM setting without reloading the page? (Use the "Re-read downloadMode" button.)
 *   Q4  Do onprogress/onload/onerror still fire, with the field shapes our code expects
 *       (response.total, response.loaded)? VM's new path polls once a second, so progress
 *       granularity has changed.
 *
 * READING THE RESULTS
 *   Each test has a flat control next to the nested one, so "blob is broken" can be told
 *   apart from "nesting is broken". Check your Downloads folder against the verdicts —
 *   a reported OK only means a callback fired, NOT that the file landed where you wanted.
 *   "NO CALLBACK" is itself a real finding: silent failure is the behaviour we most suspect.
 */

(function () {
    'use strict';

    const NESTED_DIR = 'vm-probe/sub folder';
    const DEFAULT_REMOTE = 'https://raw.githubusercontent.com/violentmonkey/violentmonkey/master/README.md';

    const downloadFn = (typeof GM_download === 'function')
        ? GM_download
        : (typeof GM !== 'undefined' && GM && typeof GM.download === 'function' ? GM.download.bind(GM) : null);

    const results = [];
    let seq = 0;
    let panel, logBox, tableBody, remoteInput;

    // ---------- helpers ----------

    const info = () => (typeof GM_info !== 'undefined' && GM_info) || {};

    // Read fresh every time: VM pushes a live SetGMI update when the option or permission
    // changes, so this must never be cached at script start.
    const readDownloadMode = () => {
        const v = info().downloadMode;
        return v === undefined ? '(undefined — handler does not expose it)' : String(v);
    };

    const truncate = (s, n) => (s = String(s), s.length > n ? s.slice(0, n) + `… (${s.length} chars)` : s);

    const DUMP_KEYS = [
        'type', 'readyState', 'status', 'statusText', 'finalUrl', 'error',
        'loaded', 'total', 'lengthComputable', 'name', 'message',
    ];

    function dump(r) {
        if (r == null) return String(r);
        if (typeof r !== 'object') return String(r);
        const out = [];
        for (const k of DUMP_KEYS) {
            if (r[k] !== undefined) out.push(`${k}=${JSON.stringify(r[k])}`);
        }
        for (const k of Object.keys(r)) {
            if (!DUMP_KEYS.includes(k) && typeof r[k] !== 'function' && typeof r[k] !== 'object') {
                out.push(`${k}=${JSON.stringify(r[k])}`);
            }
        }
        return out.length ? `{ ${truncate(out.join(', '), 400)} }` : '{}';
    }

    function log(msg, cls) {
        const line = document.createElement('div');
        line.className = 'vmp-line' + (cls ? ' vmp-' + cls : '');
        line.textContent = msg;
        logBox.appendChild(line);
        logBox.scrollTop = logBox.scrollHeight;
        console.log('[vm-probe]', msg);
    }

    function record(name, verdict, detail, mode, ms, events) {
        results.push({ name, verdict, detail, mode, ms, events });
        const tr = document.createElement('tr');
        const ok = /^OK/.test(verdict);
        const cell = (t, cls) => {
            const td = document.createElement('td');
            td.textContent = t;
            if (cls) td.className = cls;
            return td;
        };
        tr.appendChild(cell(name));
        tr.appendChild(cell(verdict, ok ? 'vmp-ok' : 'vmp-err'));
        tr.appendChild(cell(`${ms}ms / ${events} ev`));
        tableBody.appendChild(tr);
        log(`◼ ${name}: ${verdict} — ${detail}`, ok ? 'ok' : 'err');
    }

    // ---------- the actual probe ----------

    function runTest(test) {
        if (!downloadFn) {
            log('No GM_download and no GM.download available — check @grant.', 'err');
            return Promise.resolve();
        }

        const n = ++seq;
        const mode = readDownloadMode();
        log(`▶ [${n}] ${test.name} — downloadMode="${mode}"`);
        log(`   name: "${test.saveName}"`);

        let url;
        try {
            url = test.makeUrl();
        } catch (e) {
            record(test.name, 'SETUP ERROR', String((e && e.message) || e), mode, 0, 0);
            return Promise.resolve();
        }
        log(`   url:  ${truncate(url, 140)}`);
        if (/^blob:/i.test(url)) {
            // The origin embedded here is the whole point of Q1.
            log(`   blob origin: ${url.slice(5).split('/').slice(0, 3).join('/')}`, 'note');
        }

        return new Promise(resolve => {
            const t0 = (performance && performance.now) ? performance.now() : Date.now();
            let settled = false;
            let events = 0;

            const finish = (verdict, detail) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                const now = (performance && performance.now) ? performance.now() : Date.now();
                record(test.name, verdict, detail, mode, Math.round(now - t0), events);
                // Revoke late so a still-running download is never yanked out from under itself.
                if (test.revoke) setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 60000);
                resolve();
            };

            const timer = setTimeout(
                () => finish('NO CALLBACK', `nothing fired within ${test.timeout / 1000}s (${events} events seen)`),
                test.timeout
            );

            const opts = {
                url,
                name: test.saveName,
                onload: r => { events++; log(`   onload    ${dump(r)}`); finish('OK (onload)', dump(r)); },
                onerror: r => { events++; log(`   onerror   ${dump(r)}`, 'err'); finish('ERROR', dump(r)); },
                ontimeout: r => { events++; log(`   ontimeout ${dump(r)}`, 'err'); finish('TIMEOUT', dump(r)); },
                onprogress: r => {
                    events++;
                    // Chatty on big files; first few then every 10th is enough to see the shape.
                    if (events <= 5 || events % 10 === 0) log(`   onprogress ${dump(r)}`);
                },
            };

            let ret;
            try {
                ret = downloadFn(opts);
            } catch (e) {
                log(`   THREW synchronously: ${(e && e.message) || e}`, 'err');
                finish('THREW', String((e && e.message) || e));
                return;
            }

            if (ret && typeof ret.then === 'function') {
                log('   (handler returned a Promise — promise-based GM.download)', 'note');
                ret.then(
                    r => { log(`   promise resolve ${dump(r)}`); finish('OK (promise)', dump(r)); },
                    e => { log(`   promise reject  ${dump(e)}`, 'err'); finish('ERROR (promise)', dump(e)); }
                );
            } else if (ret && typeof ret.abort === 'function') {
                log('   (handler returned a control object with abort())', 'note');
            }
        });
    }

    // ---------- test definitions ----------

    function makeBlob() {
        // ~64KB so it is not so tiny that it completes before anything can be observed.
        const chunk = 'vm-download-probe blob payload. ';
        const body = new Array(2048).fill(chunk).join('');
        return URL.createObjectURL(new Blob([body], { type: 'application/octet-stream' }));
    }

    const TESTS = [
        {
            // Q1 + Q2 together: the exact shape our real script uses.
            name: 'blob → nested',
            saveName: `${NESTED_DIR}/blob-nested.txt`,
            makeUrl: makeBlob,
            revoke: true,
            timeout: 15000,
        },
        {
            // Control for Q1: isolates "blob is broken" from "nesting is broken".
            name: 'blob → flat',
            saveName: 'vm-probe-blob-flat.txt',
            makeUrl: makeBlob,
            revoke: true,
            timeout: 15000,
        },
        {
            // Q2 + Q4 on the path VM's new API is actually designed for.
            name: 'remote → nested',
            saveName: `${NESTED_DIR}/remote-nested.bin`,
            makeUrl: () => remoteInput.value.trim() || DEFAULT_REMOTE,
            timeout: 30000,
        },
        {
            name: 'remote → flat',
            saveName: 'vm-probe-remote-flat.bin',
            makeUrl: () => remoteInput.value.trim() || DEFAULT_REMOTE,
            timeout: 30000,
        },
        {
            // Cheap extra data point: data: URLs are neither page-origin blobs nor network fetches.
            name: 'data: → nested',
            saveName: `${NESTED_DIR}/data-nested.txt`,
            makeUrl: () => 'data:text/plain;base64,' + btoa('vm-download-probe data url payload'),
            timeout: 15000,
        },
    ];

    async function runAll() {
        log('─── run all ───────────────────────────────');
        for (const t of TESTS) {
            await runTest(t);
            await new Promise(r => setTimeout(r, 1200)); // keep the download bar readable
        }
        log('─── done. Now CHECK YOUR DOWNLOADS FOLDER ──', 'note');
        log('A verdict of OK only means a callback fired — verify where the file actually landed.', 'note');
    }

    function environment() {
        const i = info();
        return [
            `handler:      ${i.scriptHandler || '(unknown)'} ${i.version || ''}`,
            `downloadMode: ${readDownloadMode()}`,
            `GM_download:  ${typeof GM_download}`,
            `GM.download:  ${(typeof GM !== 'undefined' && GM && typeof GM.download) || 'undefined'}`,
            `injectInto:   ${(i.injectInto || i.script && i.script.injectInto) || '(unknown)'}`,
            `page origin:  ${location.origin}`,
            `userAgent:    ${navigator.userAgent}`,
        ].join('\n');
    }

    function copyAll() {
        const text = [
            '=== vm-download-probe ===',
            environment(),
            '',
            '=== results ===',
            ...results.map(r => `${r.name}\t${r.verdict}\t${r.ms}ms\t${r.events} events\tmode=${r.mode}\t${r.detail}`),
            '',
            '=== log ===',
            ...Array.from(logBox.children).map(el => el.textContent),
        ].join('\n');
        navigator.clipboard.writeText(text).then(
            () => log('Copied report to clipboard.', 'ok'),
            e => { console.log(text); log(`Clipboard blocked (${e}) — full report dumped to console instead.`, 'err'); }
        );
    }

    // ---------- UI ----------

    function build() {
        const style = document.createElement('style');
        style.textContent = `
            #vmp { position: fixed; top: 10px; right: 10px; z-index: 2147483647; width: 560px;
                   max-height: 90vh; overflow: auto; background: #14161a; color: #d8dee9;
                   font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
                   border: 1px solid #3b4252; border-radius: 8px; padding: 10px;
                   box-shadow: 0 6px 24px rgba(0,0,0,.45); }
            #vmp h1 { font-size: 13px; margin: 0 0 6px; color: #88c0d0; }
            #vmp pre { margin: 0 0 8px; white-space: pre-wrap; word-break: break-all; color: #a3adbd; }
            #vmp button { background: #2e3440; color: #e5e9f0; border: 1px solid #4c566a;
                          border-radius: 5px; padding: 4px 9px; margin: 0 4px 6px 0; cursor: pointer;
                          font: inherit; }
            #vmp button:hover { background: #3b4252; }
            #vmp input { width: 100%; box-sizing: border-box; background: #0f1115; color: #d8dee9;
                         border: 1px solid #3b4252; border-radius: 5px; padding: 4px 6px;
                         margin-bottom: 6px; font: inherit; }
            #vmp table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
            #vmp td { border-bottom: 1px solid #2e3440; padding: 2px 4px; vertical-align: top; }
            #vmp .vmp-log { background: #0f1115; border: 1px solid #2e3440; border-radius: 5px;
                            padding: 6px; height: 260px; overflow: auto; }
            #vmp .vmp-line { white-space: pre-wrap; word-break: break-all; }
            #vmp .vmp-ok { color: #a3be8c; }
            #vmp .vmp-err { color: #bf616a; }
            #vmp .vmp-note { color: #ebcb8b; }
            #vmp .vmp-hint { color: #6c7686; margin-bottom: 6px; }
        `;
        document.head.appendChild(style);

        panel = document.createElement('div');
        panel.id = 'vmp';
        panel.innerHTML = `
            <h1>VM download probe</h1>
            <pre id="vmp-env"></pre>
            <div class="vmp-hint">Remote test URL (paste a large file to exercise onprogress):</div>
            <input id="vmp-remote" spellcheck="false">
            <div id="vmp-buttons"></div>
            <table><tbody id="vmp-results"></tbody></table>
            <div class="vmp-log" id="vmp-logbox"></div>
        `;
        document.body.appendChild(panel);

        logBox = panel.querySelector('#vmp-logbox');
        tableBody = panel.querySelector('#vmp-results');
        remoteInput = panel.querySelector('#vmp-remote');
        remoteInput.value = DEFAULT_REMOTE;
        panel.querySelector('#vmp-env').textContent = environment();

        const buttons = panel.querySelector('#vmp-buttons');
        const addBtn = (label, fn) => {
            const b = document.createElement('button');
            b.textContent = label;
            b.addEventListener('click', fn);
            buttons.appendChild(b);
        };

        addBtn('Run all', runAll);
        for (const t of TESTS) addBtn(t.name, () => runTest(t));
        addBtn('Re-read downloadMode', () => {
            // Q3: toggle the VM setting, then click this WITHOUT reloading.
            panel.querySelector('#vmp-env').textContent = environment();
            log(`downloadMode is now "${readDownloadMode()}"`, 'note');
        });
        addBtn('Copy report', copyAll);
        addBtn('Clear log', () => { logBox.textContent = ''; });

        log(`Ready. Handler: ${info().scriptHandler || '?'} ${info().version || ''}, downloadMode="${readDownloadMode()}"`, 'note');
        if (readDownloadMode() !== 'browser') {
            log('downloadMode is not "browser" — enable "Use browser download API" AND grant the downloads permission, then click "Re-read downloadMode".', 'err');
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', build, { once: true });
    } else {
        build();
    }
})();
