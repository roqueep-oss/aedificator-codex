// Bridge para o tsserver (TypeScript Language Service) — permite consultas
// TIPADAS de projeto inteiro (quickinfo/definição/completions) contra arquivos
// FECHADOS, não só os abertos no Monaco. Um processo tsserver por PROJECT_ROOT,
// criado sob demanda. Fala o protocolo clássico do tsserver (JSON + framing
// Content-Length) via stdio.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

let cachedTsserverPath = null;
function tsserverPath() {
    if (cachedTsserverPath !== null) return cachedTsserverPath;
    cachedTsserverPath = '';
    try {
        // dirname(resolve('typescript')) JÁ é a pasta lib (exports aponta p/ lá).
        // Preferimos o package.json (raiz do pacote) e montamos lib/tsserver.js.
        const pkgFile = require.resolve('typescript/package.json');
        const pkgRoot = path.dirname(pkgFile);
        const candidate = path.join(pkgRoot, 'lib', 'tsserver.js');
        if (fs.existsSync(candidate)) cachedTsserverPath = candidate;
        else {
            const libDir = path.dirname(require.resolve('typescript'));
            const alt = path.join(libDir, 'tsserver.js');
            if (fs.existsSync(alt)) cachedTsserverPath = alt;
        }
    } catch (e) { cachedTsserverPath = ''; }
    return cachedTsserverPath;
}

const sessions = new Map(); // PROJECT_ROOT -> sessão

function disposeRoot(root) {
    const s = sessions.get(root);
    if (!s) return;
    try { s.child.kill(); } catch (e) {}
    sessions.delete(root);
}

function disposeAll() {
    for (const root of [...sessions.keys()]) disposeRoot(root);
}

function getSession(root) {
    const existing = sessions.get(root);
    if (existing && existing.child.exitCode === null) return existing;
    if (existing) sessions.delete(root);

    const child = spawn(process.execPath, [tsserverPath()], {
        cwd: root,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['pipe', 'pipe', 'pipe']
    });
    const session = { child, root, pending: new Map(), seq: 0, buf: Buffer.alloc(0) };
    sessions.set(root, session);

    const CRLFCRLF = Buffer.from('\r\n\r\n');
    child.stdout.on('data', (chunk) => {
        session.buf = Buffer.concat([session.buf, chunk]);
        for (;;) {
            const headEnd = session.buf.indexOf(CRLFCRLF);
            if (headEnd === -1) break;
            const header = session.buf.slice(0, headEnd).toString('utf8');
            const m = /Content-Length:\s*(\d+)/i.exec(header);
            if (!m) { session.buf = session.buf.slice(headEnd + 4); continue; }
            const len = parseInt(m[1], 10);
            const bodyStart = headEnd + 4;
            if (session.buf.length < bodyStart + len) break;
            const body = session.buf.slice(bodyStart, bodyStart + len).toString('utf8');
            session.buf = session.buf.slice(bodyStart + len);
            let msg;
            try { msg = JSON.parse(body); } catch (e) { continue; }
            if (msg && msg.type === 'response' && msg.request_seq != null) {
                const p = session.pending.get(msg.request_seq);
                if (p) {
                    session.pending.delete(msg.request_seq);
                    clearTimeout(p.timer);
                    if (msg.success) p.resolve(msg.body);
                    else p.reject(new Error('tsserver: ' + (msg.message || 'erro desconhecido')));
                }
            }
            // Eventos (telemetry/diag/log) são ignorados neste bridge.
        }
    });
    child.stderr.on('data', () => {});
    child.on('exit', () => {
        for (const p of session.pending.values()) { clearTimeout(p.timer); p.reject(new Error('tsserver encerrou')); }
        session.pending.clear();
        if (sessions.get(root) === session) sessions.delete(root);
    });
    return session;
}

function send(root, command, args, timeoutMs = 20000) {
    const session = getSession(root);
    const requestSeq = ++session.seq;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            session.pending.delete(requestSeq);
            reject(new Error('timeout tsserver: ' + command));
        }, timeoutMs);
        session.pending.set(requestSeq, { resolve, reject, timer });
        // Protocolo do tsserver: entrada é um JSON por linha (sem headers);
        // a saída dele, por sua vez, é header-framed (Content-Length), que o
        // parser acima decodifica.
        try {
            session.child.stdin.write(JSON.stringify({ seq: requestSeq, type: 'request', command, arguments: args || {} }) + '\n');
        } catch (e) {
            clearTimeout(timer);
            session.pending.delete(requestSeq);
            reject(e);
        }
    });
}

function scriptKindFor(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.tsx') return 'TSX';
    if (ext === '.ts' || ext === '.mts' || ext === '.cts') return 'TS';
    if (ext === '.jsx') return 'JSX';
    return 'JS';
}

// Garante o arquivo aberto no tsserver (in-memory). content é opcional: sem ele,
// lê do disco. Reabrir com conteúdo novo substitui o estado anterior.
async function ensureOpenFile(root, relPath, content) {
    const file = path.resolve(root, relPath);
    const fileContent = content !== undefined && content !== null
        ? content
        : (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
    await send(root, 'open', { file, fileContent, scriptKindName: scriptKindFor(relPath) });
    return file;
}

async function quickinfo(root, relPath, line, offset, content) {
    const file = await ensureOpenFile(root, relPath, content);
    // Nas primeiras consultas o tsserver ainda está montando o gráfico do
    // projeto e pode responder "No content available"; tenta de novo.
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            return await send(root, 'quickinfo', { file, line, offset });
        } catch (e) {
            lastErr = e;
            if (!/No content available/.test(e.message)) throw e;
            await new Promise((r) => setTimeout(r, 400));
        }
    }
    throw lastErr;
}

async function definition(root, relPath, line, offset, content) {
    const file = await ensureOpenFile(root, relPath, content);
    return send(root, 'definition', { file, line, offset });
}

async function references(root, relPath, line, offset, content) {
    const file = await ensureOpenFile(root, relPath, content);
    return send(root, 'references', { file, line, offset });
}

// Retorna as localizações que seriam renomeadas (tsserver 'rename'):
// { info, locs: [{ file, start:{line,offset}, end:{line,offset} }] }.
async function renameLocations(root, relPath, line, offset, content) {
    const file = await ensureOpenFile(root, relPath, content);
    return send(root, 'rename', { file, line, offset, findInComments: false, findInStrings: false });
}

async function completions(root, relPath, line, offset, prefix, content) {
    const file = await ensureOpenFile(root, relPath, content);
    return send(root, 'completions', { file, line, offset, prefix });
}

module.exports = {
    tsserverPath, disposeRoot, disposeAll,
    ensureOpenFile, quickinfo, definition, references, renameLocations, completions, send
};
