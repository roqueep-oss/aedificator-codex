const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');

const PORT = 3998;
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER_PATH = path.join(__dirname, '..', 'backend', 'server.js');

function startServer() {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aedificator-snap-'));
    fs.writeFileSync(path.join(projectRoot, 'a.txt'), 'conteudo A');
    fs.mkdirSync(path.join(projectRoot, 'sub'));
    fs.writeFileSync(path.join(projectRoot, 'sub', 'b.txt'), 'conteudo B');
    const child = spawn(process.execPath, [SERVER_PATH], {
        env: { ...process.env, PORT: String(PORT), BACKEND_TOKEN: '', PROJECT_ROOT: projectRoot },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stderr.on('data', () => {});
    return { child, projectRoot };
}
function stopServer(child, root) { child.kill(); fs.rmSync(root, { recursive: true, force: true }); }
function waitForPort(t = 10000) {
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
function post(url, body) { return fetch(BASE + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }

test('snapshot: criar, listar, diff e restaurar', async (t) => {
    const { child, projectRoot } = startServer();
    try {
        await waitForPort();

        // criar
        let r = await (await post('/api/snapshot/create', { name: 'v1', note: 'estado inicial' })).json();
        assert.equal(r.success, true, r.error);

        // listar
        r = await (await post('/api/snapshot/list')).json();
        assert.equal(r.success, true);
        assert.equal(r.snapshots.length, 1);
        assert.equal(r.snapshots[0].name, 'v1');

        // mudar arquivos
        fs.writeFileSync(path.join(projectRoot, 'a.txt'), 'MUDADO');
        fs.writeFileSync(path.join(projectRoot, 'novo.txt'), 'arquivo novo');

        // diff
        r = await (await post('/api/snapshot/diff', { name: 'v1' })).json();
        assert.equal(r.success, true);
        assert.ok(r.changes.modified.includes('a.txt'));
        assert.ok(r.changes.created.includes('novo.txt'));

        // restaurar
        r = await (await post('/api/snapshot/restore', { name: 'v1' })).json();
        assert.equal(r.success, true);
        assert.equal(fs.readFileSync(path.join(projectRoot, 'a.txt'), 'utf-8'), 'conteudo A');
        // restaura apenas sobrescreve; não apaga arquivos criados depois (postura segura)
        assert.equal(fs.existsSync(path.join(projectRoot, 'novo.txt')), true);
        assert.equal(fs.readFileSync(path.join(projectRoot, 'sub', 'b.txt'), 'utf-8'), 'conteudo B');
    } finally {
        stopServer(child, projectRoot);
    }
});