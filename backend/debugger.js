// =============================================
//  DEBUGGER - depuração passo a passo via CDP
//  (Protocolo de inspeção do Node.js)
// =============================================
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const path = require('path');
const { WebSocket } = require('ws');

let session = null;

// ===== UTILITÁRIOS REMOTE OBJECT → texto =====
function remoteToString(remote) {
    if (!remote) return 'undefined';
    if (remote.type === 'undefined') return 'undefined';
    if (remote.type === 'string') return String(remote.value);
    if (remote.type === 'number' || remote.type === 'boolean') return String(remote.value);
    if (remote.type === 'bigint') return String(remote.value) + 'n';
    if (remote.type === 'symbol') return remote.description || 'Symbol()';
    if (remote.type === 'function') return remote.description || 'function';
    if (remote.type === 'object') {
        if ('value' in remote && remote.value !== undefined) return JSON.stringify(remote.value);
        if (remote.subtype === 'null') return 'null';
        if (remote.subtype === 'array') {
            const len = remote.preview ? remote.preview.properties.filter(p => /^\d+$/.test(p.name)).length : '?';
            return `Array(${len})`;
        }
        if (remote.subtype === 'error') return remote.description || 'Error';
        if (remote.description) return remote.description;
        if (remote.objectId) return '{…}';
        return '{}';
    }
    return remote.description || String(remote);
}

async function getProperties(send, objectId) {
    if (!objectId) return [];
    try {
        const res = await send('Runtime.getProperties', { objectId, ownProperties: false });
        const list = (res && res.result) || [];
        return list
            .filter(p => p.enumerable && !/^__/.test(p.name))
            .slice(0, 40)
            .map(p => ({ name: p.name, value: remoteToString(p.value) }));
    } catch (e) {
        return [];
    }
}

function parseScopeType(type) {
    const map = { local: 'Local', closure: 'Closure', global: 'Global', with: 'With', catch: 'Catch', block: 'Block' };
    return map[type] || type;
}

// ===== GERENCIAMENTO DA SESSÃO =====
function isRunning() {
    return !!(session && session.child && !session.child.killed);
}

function sendRaw(sessionObj, method, params) {
    return new Promise((resolve, reject) => {
        if (!sessionObj || !sessionObj.ws || sessionObj.ws.readyState !== WebSocket.OPEN) {
            return reject(new Error('Depurador desconectado'));
        }
        const id = ++sessionObj.seq;
        const handler = (msg) => {
            if (msg.id !== id) return;
            sessionObj.ws.off('message', handler);
            if (msg.error) return reject(new Error(msg.error.message || 'Erro do depurador'));
            resolve(msg.result);
        };
        sessionObj.ws.on('message', handler);
        sessionObj.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
}

function broadcast(onEvent, type, payload) {
    if (onEvent) {
        try { onEvent({ type, ...payload }); } catch (e) {}
    }
}

function sendDap(sessionObj, command, args) {
    return new Promise((resolve, reject) => {
        if (!sessionObj || !sessionObj.ws || sessionObj.ws.readyState !== WebSocket.OPEN) {
            return reject(new Error('Depurador desconectado'));
        }
        const seq = ++sessionObj.seq;
        const msg = JSON.stringify({ seq, type: 'request', command, arguments: args || {} });
        const handler = (data) => {
            let resp;
            try { resp = JSON.parse(data.toString()); } catch (e) { return; }
            if (resp.seq !== seq && resp.request_seq !== seq) return;
            sessionObj.ws.off('message', handler);
            if (!resp.success) return reject(new Error(resp.message || 'Comando DAP falhou'));
            resolve(resp.body || {});
        };
        sessionObj.ws.on('message', handler);
        sessionObj.ws.send(msg);
    });
}

async function dapGetVariables(sessionObj, frameId) {
    try {
        const scopesRes = await sendDap(sessionObj, 'scopes', { frameId });
        const vars = [];
        for (const scope of (scopesRes.scopes || [])) {
            const scopeName = scope.name || 'Local';
            const props = [];
            try {
                const varRes = await sendDap(sessionObj, 'variables', { variablesReference: scope.variablesReference });
                for (const v of (varRes.variables || [])) {
                    props.push({ name: v.name, value: v.value || (v.type || '?') });
                }
            } catch (e) {}
            vars.push({ name: scopeName, properties: props });
        }
        return vars;
    } catch (e) {
        return [{ name: 'Local', properties: [] }];
    }
}

function stepDap(command, args) {
    if (!isRunning() || !session.ws) {
        return Promise.reject(new Error('Depurador não está em execução.'));
    }
    return sendDap(session, command, args || { threadId: session.lastThreadId || 1 });
}

function destroySession(emitEnd) {
    if (!session) return;
    const s = session;
    session = null;
    try { if (s.ws) s.ws.terminate(); } catch (e) {}
    try { if (s.child && !s.child.killed) s.child.kill(); } catch (e) {}
    if (emitEnd) {
        broadcast(s.onEvent, 'debug-ended', { code: 0 });
    }
}

function startDebug({ file, breakpoints, onEvent }) {
    return new Promise((resolve, reject) => {
        if (session) {
            return reject(Object.assign(new Error('Já existe uma sessão de debug em andamento. Pare antes de iniciar outra.'), { status: 409 }));
        }
        const child = spawn(process.execPath, ['--inspect-brk=127.0.0.1:0', file], {
            cwd: path.dirname(file),
            env: { ...process.env, NODE_NO_WARNINGS: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
        });

        const sess = {
            child,
            ws: null,
            seq: 0,
            onEvent,
            targetFile: path.resolve(file),
            scriptIds: new Map(),
            breakpoints: Array.isArray(breakpoints) ? breakpoints.map(bp => typeof bp === 'object' ? bp : { line: Number(bp), condition: '' }) : [],
            bpMap: new Map()
        };
        session = sess;

        let wsUrl = null;
        let stderrBuf = '';
        let connected = false;
        let settled = false;
        const finish = (err, result) => {
            if (settled) return;
            settled = true;
            if (err) {
                destroySession(true);
                reject(err);
            } else {
                resolve(result);
            }
        };

        const timeout = setTimeout(() => {
            finish(new Error('Timeout ao conectar no depurador do Node.'));
        }, 15000);

        child.stderr.on('data', (d) => {
            stderrBuf += d.toString('utf8');
            const m = /ws:\/\/127\.0\.0\.1:\d+\/[a-zA-Z0-9-]+/.exec(stderrBuf);
            if (m && !connected) {
                wsUrl = m[0];
                connect();
            }
        });

        child.stdout.on('data', (d) => {
            broadcast(onEvent, 'debug-output', { text: d.toString('utf8') });
        });

        child.on('error', (err) => {
            clearTimeout(timeout);
            finish(new Error('Não foi possível iniciar o Node: ' + err.message));
        });

        child.on('close', (code) => {
            clearTimeout(timeout);
            if (session === sess) {
                session = null;
                broadcast(onEvent, 'debug-ended', { code: code === null ? -1 : code });
            }
            // Se o processo encerrou sem conectar no WebSocket do depurador, a
            // Promise ficaria pendente para sempre — resolve com erro em vez disso.
            if (!settled) {
                finish(new Error('Node encerrou antes de conectar no depurador (código ' + (code === null ? -1 : code) + ')'));
            }
        });

        function connect() {
            if (connected) return;
            connected = true;
            let sock;
            try {
                sock = new WebSocket(wsUrl);
            } catch (e) {
                clearTimeout(timeout);
                return finish(new Error('Falha ao abrir WebSocket do depurador'));
            }
            sess.ws = sock;

            sock.on('open', async () => {
                try {
                    await sendRaw(sess, 'Runtime.enable');
                    await sendRaw(sess, 'Debugger.enable');
                    clearTimeout(timeout);
                    finish(null, { success: true });
                } catch (e) {
                    finish(new Error('Falha ao ativar o depurador: ' + e.message));
                }
            });

            sock.on('message', (data) => {
                let msg;
                try { msg = JSON.parse(data.toString()); } catch (e) { return; }
                if (msg.method) handleEvent(msg.method, msg.params || {});
            });

            sock.on('close', () => {
                if (session === sess) {
                    session = null;
                    broadcast(onEvent, 'debug-ended', { code: 0 });
                }
            });

            sock.on('error', () => {});
        }

        async function handleEvent(method, params) {
            if (method === 'Debugger.scriptParsed') {
                const url = params.url || '';
                const scriptId = params.scriptId;
                sess.scriptIds.set(scriptId, url);
                if (url && matchesTarget(url, sess.targetFile) && sess.breakpoints.length) {
                    setBreakpointsForUrl(sess, url);
                }
                return;
            }

            if (method === 'Debugger.paused') {
                const hitBps = params.hitBreakpoints || [];
                const logpoint = detectLogpoint(sess, hitBps);
                if (logpoint) {
                    try {
                        const evalRes = await sendRaw(sess, 'Debugger.evaluateOnCallFrame', {
                            callFrameId: (params.callFrames && params.callFrames[0] && params.callFrames[0].callFrameId) || '0',
                            expression: logpoint,
                            returnByValue: true,
                            generatePreview: true
                        });
                        const value = evalRes && evalRes.result ? remoteToString(evalRes.result) : 'undefined';
                        broadcast(onEvent, 'debug-output', { text: '[logpoint] ' + logpoint + ' = ' + value + '\n' });
                    } catch (e) {
                        broadcast(onEvent, 'debug-output', { text: '[logpoint] ' + logpoint + '\n' });
                    }
                    await sendRaw(sess, 'Debugger.resume');
                    return;
                }
                emitPaused(sess, params);
                return;
            }

            if (method === 'Runtime.consoleAPICalled') {
                const text = (params.args || []).map(remoteToString).join(' ') +
                    (params.type && params.type !== 'log' ? ` (${params.type})` : '');
                if (text) broadcast(onEvent, 'debug-output', { text: text + '\n' });
                return;
            }

            if (method === 'Runtime.exceptionThrown') {
                const desc = params.exceptionDetails && params.exceptionDetails.exception;
                const text = 'Uncaught ' + (remoteToString(desc) || (params.exceptionDetails && params.exceptionDetails.text) || 'Exception') + '\n';
                broadcast(onEvent, 'debug-output', { text });
                return;
            }

            if (method === 'Runtime.executionContextDestroyed') {
                return;
            }
        }

        async function setBreakpointsForUrl(s, url) {
            for (const bp of s.breakpoints) {
                try {
                    const line = bp.line;
                    const condition = bp.condition || '';
                    const logMessage = bp.logMessage || '';
                    const params = { url, lineNumber: line - 1 };
                    if (condition && !logMessage) params.condition = condition;
                    if (logMessage) params.condition = '(()=>{const __lp=' + logMessage + ';})()';
                    const result = await sendRaw(s, 'Debugger.setBreakpointByUrl', params);
                    const bpId = (result && result.breakpointId) || '';
                    if (bpId) {
                        s.bpMap.set(bpId, { line, condition, logMessage });
                    }
                } catch (e) {}
            }
        }

        function detectLogpoint(s, hitBps) {
            for (const bpId of hitBps) {
                const bp = s.bpMap.get(bpId);
                if (bp && bp.logMessage) return bp.logMessage;
            }
            return null;
        }

        async function emitPaused(s, params) {
            const reason = params.reason || 'pause';
            const frames = params.callFrames || [];
            const top = frames[0] || {};
            s.lastFrameId = (top.callFrameId) || '0';
            const url = top.url || s.scriptIds.get(top.location && top.location.scriptId) || s.targetFile;
            const line = top.location ? top.location.lineNumber + 1 : 0;

            const scopes = [];
            for (const scope of (top.scopeChain || []).slice(0, 4)) {
                const props = await getProperties(sendRaw.bind(null, s), scope.object && scope.object.objectId);
                if (scope.type === 'global' && !props.length) continue;
                scopes.push({ name: parseScopeType(scope.type), properties: props });
            }

            broadcast(s.onEvent, 'debug-paused', {
                line,
                filename: url,
                reason,
                variables: { scopes }
            });
        }
    });
}

function matchesTarget(url, filePath) {
    const pathFwd = filePath.split(path.sep).join('/');
    const urlLower = String(url).toLowerCase();
    if (urlLower.includes(pathFwd.toLowerCase())) return true;
    try {
        const fileUrl = pathToFileURL(filePath).href.toLowerCase();
        return urlLower === fileUrl;
    } catch (e) {
        return false;
    }
}

function stopDebug() {
    const wasRunning = isRunning();
    destroySession(false);
    return { success: true, stopped: wasRunning };
}

// =============================================
//  DEBUG CHROME / EDGE (Browser CDP)
// =============================================
function startChromeDebug({ url, onEvent }) {
    return new Promise((resolve, reject) => {
        if (session) {
            return reject(Object.assign(new Error('Já existe uma sessão de debug em andamento.'), { status: 409 }));
        }
        const child = spawn('start', ['msedge', '--remote-debugging-port=9222', '--no-first-run', '--no-default-browser-check', '--user-data-dir=' + require('os').tmpdir() + '/aed-browser-debug'], {
            shell: true,
            stdio: 'ignore',
            windowsHide: true
        });
        const sess = { child, ws: null, seq: 0, onEvent, browser: true };
        session = sess;

        let retries = 0;
        const tryConnect = () => {
            retries++;
            const http = require('http');
            http.get('http://127.0.0.1:9222/json/version', (res) => {
                let body = '';
                res.on('data', d => body += d);
                res.on('end', () => {
                    try {
                        const info = JSON.parse(body);
                        const wsUrl = info.webSocketDebuggerUrl;
                        if (!wsUrl) {
                            if (retries < 30) return setTimeout(tryConnect, 500);
                            return reject(new Error('Timeout ao conectar no browser'));
                        }
                        let sock;
                        try { sock = new WebSocket(wsUrl); } catch (e) {
                            return reject(new Error('Falha ao abrir WebSocket do browser'));
                        }
                        sess.ws = sock;
                        sock.on('open', async () => {
                            try {
                                await sendRaw(sess, 'Runtime.enable');
                                await sendRaw(sess, 'Debugger.enable');
                                await sendRaw(sess, 'Page.enable');
                                if (url) {
                                    await sendRaw(sess, 'Page.navigate', { url });
                                }
                                resolve({ success: true, browser: 'Chrome/Edge' });
                            } catch (e) {
                                reject(new Error('Falha ao ativar debug do browser: ' + e.message));
                            }
                        });
                        sock.on('message', (data) => {
                            let msg;
                            try { msg = JSON.parse(data.toString()); } catch (e) { return; }
                            if (msg.method === 'Runtime.consoleAPICalled') {
                                const args = msg.params.args || [];
                                const text = args.map(a => a.value !== undefined ? String(a.value) : a.description || '').join(' ');
                                if (text) broadcast(onEvent, 'debug-output', { text: text + '\n' });
                            }
                            if (msg.method === 'Runtime.exceptionThrown') {
                                const desc = msg.params.exceptionDetails && msg.params.exceptionDetails.exception;
                                broadcast(onEvent, 'debug-output', { text: 'Uncaught: ' + (desc ? desc.description || desc.value : 'Exception') + '\n' });
                            }
                        });
                        sock.on('close', () => {
                            if (session === sess) { session = null; broadcast(onEvent, 'debug-ended', { code: 0 }); }
                        });
                        sock.on('error', () => {});
                    } catch (e) {
                        if (retries < 30) setTimeout(tryConnect, 500);
                        else reject(new Error('Falha ao obter WebSocket URL do browser'));
                    }
                });
            }).on('error', () => {
                if (retries < 30) setTimeout(tryConnect, 500);
                else reject(new Error('Browser não detectado. Instale Chrome ou Edge.'));
            });
        };
        setTimeout(tryConnect, 3000);
    });
}

// =============================================
//  DEBUG PYTHON (debugpy)
// =============================================
function startPythonDebug({ file, breakpoints, onEvent }) {
    return new Promise((resolve, reject) => {
        if (session) {
            return reject(Object.assign(new Error('Já existe uma sessão de debug em andamento.'), { status: 409 }));
        }
        const child = spawn('python', ['-m', 'debugpy', '--listen', '5678', '--wait-for-client', file], {
            cwd: path.dirname(file),
            env: { ...process.env, PYTHONUNBUFFERED: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
        });
        const sess = { child, ws: null, seq: 0, onEvent, breakpoints: breakpoints || [], type: 'python', lastThreadId: 1 };
        session = sess;

        child.stdout.on('data', (d) => broadcast(onEvent, 'debug-output', { text: d.toString('utf8') }));
        child.stderr.on('data', (d) => broadcast(onEvent, 'debug-output', { text: d.toString('utf8') }));
        child.on('close', (code) => {
            if (session === sess) { session = null; broadcast(onEvent, 'debug-ended', { code }); }
        });

        let retries = 0;
        const tryConnect = () => {
            retries++;
            const net = require('net');
            const client = new net.Socket();
            client.connect(5678, '127.0.0.1', () => {
                client.destroy();
                let sock;
                try { sock = new WebSocket('ws://127.0.0.1:5678'); } catch (e) {
                    return reject(new Error('Falha ao conectar ao debugpy'));
                }
                sess.ws = sock;
                sock.on('open', async () => {
                    try {
                        if (sess.breakpoints.length) {
                            for (const bp of sess.breakpoints) {
                                try {
                                    await sendDap(sess, 'setBreakpoints', {
                                        source: { path: file },
                                        breakpoints: [{ line: bp.line || bp }]
                                    });
                                } catch (e) {}
                            }
                        }
                        await sendDap(sess, 'configurationDone', {});
                    } catch (e) {}
                    resolve({ success: true, type: 'python' });
                });
                sock.on('message', async (data) => {
                    let msg;
                    try { msg = JSON.parse(data.toString()); } catch (e) { return; }
                    if (msg.type === 'event' && msg.event === 'output') {
                        broadcast(onEvent, 'debug-output', { text: (msg.body.output || '') + '\n' });
                    }
                    if (msg.type === 'event' && msg.event === 'stopped') {
                        sess.lastThreadId = msg.body.threadId || 1;
                        const threadId = sess.lastThreadId;
                        let stackFrames = [];
                        try {
                            const st = await sendDap(sess, 'stackTrace', { threadId });
                            stackFrames = (st.stackFrames || []).slice(0, 20).map(f => ({
                                id: f.id, name: f.name || '?', line: f.line, file: f.source ? f.source.path || file : file
                            }));
                            sess.lastFrameId = stackFrames.length ? stackFrames[0].id : 0;
                        } catch (e) {}
                        const scopes = await dapGetVariables(sess, sess.lastFrameId || 0);
                        broadcast(onEvent, 'debug-paused', {
                            line: stackFrames.length ? stackFrames[0].line : 0,
                            reason: msg.body.reason || 'breakpoint',
                            filename: file,
                            variables: { scopes },
                            frames: stackFrames
                        });
                    }
                });
                sock.on('close', () => {
                    if (session === sess) { session = null; broadcast(onEvent, 'debug-ended', { code: 0 }); }
                });
                sock.on('error', (e) => {
                    if (retries < 15) return setTimeout(tryConnect, 500);
                    reject(new Error('debugpy não encontrado. Execute: pip install debugpy'));
                });
            });
            client.on('error', () => {
                if (retries < 15) return setTimeout(tryConnect, 500);
                reject(new Error('Timeout ao conectar no debugpy (porta 5678)'));
            });
        };
        setTimeout(tryConnect, 1000);
    });
}

// =============================================
//  DEBUG GO (dlv)
// =============================================
function startGoDebug({ file, cwd, onEvent, breakpoints }) {
    return new Promise((resolve, reject) => {
        if (session) {
            return reject(Object.assign(new Error('Já existe uma sessão de debug em andamento.'), { status: 409 }));
        }
        const child = spawn('dlv', ['dap', '--listen=127.0.0.1:2345'], {
            cwd: cwd || path.dirname(file),
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
        });
        const sess = { child, ws: null, seq: 0, onEvent, type: 'go', lastThreadId: 1, breakpoints: breakpoints || [] };
        session = sess;

        child.stdout.on('data', (d) => broadcast(onEvent, 'debug-output', { text: d.toString('utf8') }));
        child.stderr.on('data', (d) => broadcast(onEvent, 'debug-output', { text: d.toString('utf8') }));
        child.on('close', (code) => {
            if (session === sess) { session = null; broadcast(onEvent, 'debug-ended', { code }); }
        });

        let retries = 0;
        const tryConnect = () => {
            retries++;
            try {
                const sock = new WebSocket('ws://127.0.0.1:2345');
                sess.ws = sock;
                sock.on('open', async () => {
                    try {
                        await sendDap(sess, 'initialize', {
                            clientID: 'aedificator',
                            adapterID: 'go',
                            linesStartAt1: true,
                            columnsStartAt1: true
                        });
                        if (sess.breakpoints.length) {
                            for (const bp of sess.breakpoints) {
                                try {
                                    await sendDap(sess, 'setBreakpoints', {
                                        source: { path: file },
                                        breakpoints: [{ line: bp.line || bp }]
                                    });
                                } catch (e) {}
                            }
                        }
                        await sendDap(sess, 'configurationDone', {});
                    } catch (e) {
                        return reject(new Error('Falha ao inicializar DAP: ' + e.message));
                    }
                    resolve({ success: true, type: 'go' });
                });
                sock.on('message', async (data) => {
                    let msg;
                    try { msg = JSON.parse(data.toString()); } catch (e) { return; }
                    if (msg.type === 'event' && msg.event === 'output') {
                        broadcast(onEvent, 'debug-output', { text: (msg.body.output || '') + '\n' });
                    }
                    if (msg.type === 'event' && msg.event === 'stopped') {
                        sess.lastThreadId = msg.body.threadId || 1;
                        const threadId = sess.lastThreadId;
                        let stackFrames = [];
                        try {
                            const st = await sendDap(sess, 'stackTrace', { threadId });
                            stackFrames = (st.stackFrames || []).slice(0, 20).map(f => ({
                                id: f.id, name: f.name || '?', line: f.line, file: f.source ? f.source.path || file : file
                            }));
                            sess.lastFrameId = stackFrames.length ? stackFrames[0].id : 0;
                        } catch (e) {}
                        const scopes = await dapGetVariables(sess, sess.lastFrameId || 0);
                        broadcast(onEvent, 'debug-paused', {
                            line: stackFrames.length ? stackFrames[0].line : 0,
                            reason: msg.body.reason || 'breakpoint',
                            filename: file,
                            variables: { scopes },
                            frames: stackFrames
                        });
                    }
                    if (msg.type === 'event' && msg.event === 'exited') {
                        broadcast(onEvent, 'debug-ended', { code: msg.body.exitCode || 0 });
                    }
                });
                sock.on('close', () => {
                    if (session === sess) { session = null; broadcast(onEvent, 'debug-ended', { code: 0 }); }
                });
                sock.on('error', () => {
                    if (retries < 15) return setTimeout(tryConnect, 500);
                    reject(new Error('Timeout ao conectar no dlv (porta 2345)'));
                });
            } catch (e) {
                if (retries < 15) return setTimeout(tryConnect, 500);
                reject(new Error('dlv não encontrado. Execute: go install github.com/go-delve/delve/cmd/dlv@latest'));
            }
        };
        setTimeout(tryConnect, 1000);
    });
}

function evaluate(expression) {
    if (!isRunning() || !session.ws) {
        return Promise.reject(new Error('Depurador não está em execução.'));
    }
    if (session.type === 'go' || session.type === 'python') {
        return sendDap(session, 'evaluate', {
            expression: String(expression),
            frameId: session.lastFrameId || 0,
            context: 'repl'
        }).then(res => res.result || 'undefined')
          .catch(e => 'Error: ' + e.message);
    }
    return sendRaw(session, 'Debugger.evaluateOnCallFrame', {
        callFrameId: session.lastFrameId || '0',
        expression: String(expression),
        returnByValue: true,
        generatePreview: true
    }).then(result => {
        if (result && result.result) return remoteToString(result.result);
        return 'undefined';
    }).catch(e => 'Error: ' + e.message);
}

function stepCommand(cmd) {
    if (!isRunning() || !session.ws) return Promise.reject(new Error('Depurador não está em execução.'));
    if (session.type === 'go') {
        const dapCmd = cmd === 'Debugger.resume' ? 'continue' :
                        cmd === 'Debugger.stepOver' ? 'next' :
                        cmd === 'Debugger.stepInto' ? 'stepIn' :
                        cmd === 'Debugger.stepOut' ? 'stepOut' : 'continue';
        return stepDap(dapCmd);
    }
    if (session.type === 'python') {
        const dapCmd = cmd === 'Debugger.resume' ? 'continue' :
                        cmd === 'Debugger.stepOver' ? 'next' :
                        cmd === 'Debugger.stepInto' ? 'stepIn' :
                        cmd === 'Debugger.stepOut' ? 'stepOut' : 'continue';
        return stepDap(dapCmd);
    }
    return sendRaw(session, cmd);
}

module.exports = {
    startDebug,
    startChromeDebug,
    startPythonDebug,
    startGoDebug,
    isRunning,
    evaluate,
    resume: () => stepCommand('Debugger.resume'),
    stepOver: () => stepCommand('Debugger.stepOver'),
    stepInto: () => stepCommand('Debugger.stepInto'),
    stepOut: () => stepCommand('Debugger.stepOut'),
    stopDebug
};
