// Bridge LSP (tsserver): consultas tipadas que resolvem símbolos de PROJETO
// INTEIRO — inclusive em arquivos FECHADOS (só leitura de disco). Prova que o
// definition/quickinfo/completions enxergam tipos definidos em outro arquivo
// que nunca foi "aberto" no bridge.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');

const PORT = 3982;
const TOKEN = 'lsp-ts-token';
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER_PATH = path.join(__dirname, '..', 'backend', 'server.js');

function startServer() {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aedificator-tslsp-'));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aedificator-tslsp-data-'));
    const child = spawn(process.execPath, [SERVER_PATH], {
        env: { ...process.env, PORT: String(PORT), BACKEND_TOKEN: TOKEN, PROJECT_ROOT: projectRoot, AED_DATA_DIR: dataDir },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stderr.on('data', () => {});
    return { child, projectRoot, dataDir };
}

function stopServer(child, projectRoot, dataDir) {
    return new Promise((resolve) => {
        if (process.platform === 'win32') {
            try { require('child_process').execSync(`taskkill /F /PID ${child.pid} /T`, { stdio: 'ignore' }); } catch (_) {}
        } else {
            child.kill('SIGKILL');
        }
        setTimeout(() => {
            for (const dir of [projectRoot, dataDir]) {
                try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
            }
            resolve();
        }, 600);
    });
}

function waitForPort(t = 15000) {
    return new Promise((res, rej) => {
        const s = Date.now();
        const c = () => {
            const sock = net.connect(PORT, '127.0.0.1');
            sock.on('connect', () => { sock.destroy(); res(); });
            sock.on('error', () => { sock.destroy(); if (Date.now() - s > t) rej(new Error('timeout')); else setTimeout(c, 200); });
        };
        c();
    });
}

async function call(url, body) {
    const res = await fetch(`${BASE}${url}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
        body: JSON.stringify(body)
    });
    return res.json();
}

const DEP = 'export class Greeter {\n  constructor(private name: string) {}\n  greet(): string {\n    return \'Olá \' + this.name;\n  }\n}\n';

const MAIN_LINES = [
    "import { Greeter } from './lib/dep';",
    "const g = new Greeter('Mundo');",
    "const msg = g.greet();",
    ''
];

test('LSP tsserver resolve tipos de arquivo FECHADO (definition + completions)', async () => {
    const { child, projectRoot, dataDir } = startServer();
    try {
        fs.mkdirSync(path.join(projectRoot, 'lib'), { recursive: true });
        fs.writeFileSync(path.join(projectRoot, 'lib', 'dep.ts'), DEP, 'utf-8');
        // main.ts está no disco; dep.ts NUNCA é aberto no bridge (fica fechado).
        const main = MAIN_LINES.join('\n');
        fs.writeFileSync(path.join(projectRoot, 'main.ts'), main, 'utf-8');

        await waitForPort();

        // 1) definition de `Greeter` (usado em main.ts) deve apontar p/ lib/dep.ts
        const mainLine2 = MAIN_LINES[1]; // "const g = new Greeter('Mundo');"
        const offsetGreeter = mainLine2.indexOf('Greeter') + 1; // 1-based
        const def = await call('/api/lsp/ts/definition', { file: 'main.ts', line: 2, offset: offsetGreeter });
        assert.strictEqual(def.success, true, JSON.stringify(def));
        const first = Array.isArray(def.body) && def.body[0];
        assert.ok(first && first.file, 'definition deve retornar localização');
        assert.match(String(first.file).replace(/\\/g, '/'), /lib\/dep\.ts$/, 'deve apontar para o arquivo FECHADO dep.ts');

        // 2) completions após `g.` incluem o método `greet` (definido no arquivo fechado)
        const mainLine3 = MAIN_LINES[2]; // "const msg = g.greet();"
        const offsetAfterDot = mainLine3.indexOf('g.') + 2 + 1; // posição logo após o '.'
        const comp = await call('/api/lsp/ts/completions', { file: 'main.ts', line: 3, offset: offsetAfterDot, prefix: '' });
        assert.strictEqual(comp.success, true, JSON.stringify(comp));
        const entries = Array.isArray(comp.body) ? comp.body : [];
        assert.ok(entries.some((e) => e && e.name === 'greet'), 'completions deve incluir greet() do arquivo fechado');

        // 3) quickinfo sobre o uso de greet mostra o tipo
        const offsetGreet = mainLine3.indexOf('greet') + 1;
        const qi = await call('/api/lsp/ts/quickinfo', { file: 'main.ts', line: 3, offset: offsetGreet });
        assert.strictEqual(qi.success, true, JSON.stringify(qi));
        assert.ok(qi.body && /Greeter/.test(qi.body.displayString || ''), 'quickinfo deve citar a classe Greeter');
        assert.match(qi.body.displayString || '', /string/);
    } finally {
        await stopServer(child, projectRoot, dataDir);
    }
});
