const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const WebSocket = require('ws');

const PORT = 3992;
const TOKEN = 'websocket-test-token';
const SERVER_PATH = path.join(__dirname, '..', 'backend', 'server.js');

let child;
let projectRoot;

function startServer() {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aedificator-ws-'));
    child = spawn(process.execPath, [SERVER_PATH], {
        env: { ...process.env, PORT: String(PORT), BACKEND_TOKEN: TOKEN, PROJECT_ROOT: projectRoot },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stderr.on('data', () => {});
}

function stopServer() {
    return new Promise((resolve) => {
        if (process.platform === 'win32') {
            try { require('child_process').execSync(`taskkill /F /PID ${child.pid} /T`, { stdio: 'ignore' }); } catch (_) {}
        } else {
            child.kill('SIGKILL');
        }
        const attempt = (n) => {
            try { fs.rmSync(projectRoot, { recursive: true, force: true }); resolve(); }
            catch (e) { if (n >= 3) resolve(); else setTimeout(() => attempt(n + 1), 300); }
        };
        setTimeout(() => attempt(0), 300);
    });
}

function waitForPort(t = 15000) {
    return new Promise((res, rej) => {
        const s = Date.now();
        const tryc = () => {
            const sock = net.connect(PORT, '127.0.0.1');
            sock.on('connect', () => { sock.destroy(); res(); });
            sock.on('error', () => { sock.destroy(); if (Date.now() - s > t) rej(new Error('timeout')); else setTimeout(tryc, 200); });
        };
        tryc();
    });
}

function openSocket() {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
        ws.on('open', () => resolve(ws));
        ws.on('error', reject);
    });
}

function nextMessage(ws, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { ws.off('message', onMsg); reject(new Error('timeout esperando mensagem')); }, timeoutMs);
        const onMsg = (data) => { clearTimeout(timer); resolve(JSON.parse(String(data))); };
        ws.once('message', onMsg);
    });
}

function waitClose(ws, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout esperando close')), timeoutMs);
        ws.once('close', (code) => { clearTimeout(timer); resolve(code); });
    });
}

before(async () => {
    startServer();
    await waitForPort();
});

after(async () => {
    await stopServer();
});

test('WebSocket rejeita mensagem sem token e fecha a conexão', async () => {
    const ws = await openSocket();
    ws.send(JSON.stringify({ type: 'stream', message: 'oi', provider: 'deepseek' }));

    const msg = await nextMessage(ws);
    assert.strictEqual(msg.type, 'error');
    assert.match(String(msg.content), /Não autorizado/);

    const code = await waitClose(ws);
    assert.ok(code === 1000 || code === 1005 || code === 1006, `deve fechar (code=${code})`);
});

test('WebSocket rejeita token incorreto', async () => {
    const ws = await openSocket();
    ws.send(JSON.stringify({ token: 'token-errado', type: 'cancel' }));

    const msg = await nextMessage(ws);
    assert.strictEqual(msg.type, 'error');
    assert.match(String(msg.content), /Não autorizado/);

    const code = await waitClose(ws);
    assert.ok(code === 1000 || code === 1005 || code === 1006, `deve fechar (code=${code})`);
});

test('WebSocket com token válido processa remote-exec sem conexão remota', async () => {
    const ws = await openSocket();
    ws.send(JSON.stringify({ token: TOKEN, type: 'remote-exec', command: 'echo ola' }));

    const msg = await nextMessage(ws);
    assert.strictEqual(msg.type, 'error');
    assert.match(String(msg.content), /Nenhuma conexao remota ativa/);

    // a conexão continua aberta (não foi derrubada pelo backend)
    const stillOpen = await new Promise((resolve) => {
        ws.once('close', () => resolve(false));
        setTimeout(() => resolve(ws.readyState === WebSocket.OPEN), 300);
    });
    assert.strictEqual(stillOpen, true, 'conexão deve permanecer aberta');
    ws.close();
});

test('WebSocket ignora mensagem malformada (JSON inválido) sem derrubar conexão', async () => {
    const ws = await openSocket();
    ws.send('isto não é json {{{');

    const stillOpen = await new Promise((resolve) => {
        ws.once('close', () => resolve(false));
        setTimeout(() => resolve(ws.readyState === WebSocket.OPEN), 400);
    });
    assert.strictEqual(stillOpen, true, 'mensagem inválida não pode derrubar a conexão');
    ws.close();
});

test('WebSocket aceita cancel sem tarefa ativa (não derruba e não restaura nada)', async () => {
    const ws = await openSocket();
    ws.send(JSON.stringify({ token: TOKEN, type: 'cancel' }));

    const stillOpen = await new Promise((resolve) => {
        ws.once('close', () => resolve(false));
        setTimeout(() => resolve(ws.readyState === WebSocket.OPEN), 400);
    });
    assert.strictEqual(stillOpen, true, 'cancel sem tarefa deve manter a conexão');
    ws.close();
});
