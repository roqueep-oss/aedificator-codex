// Snapshots rotulados (versões completas da pasta) — /api/snapshot/*.
// Extraído de server.js. Dependências dinâmicas (root do projeto, resolveSafePath,
// sanitizeClientError, conteúdo atual dos arquivos) são injetadas via configureSnapshot
// no boot do server.js, então respeitam mudanças de PROJECT_ROOT em runtime.

const fs = require('fs');
const path = require('path');
const { walkProjectFiles } = require('./project-files');

const ctx = {
    getProjectRoot: () => null,
    backupDirName: () => '.aedificator-codex-ide-backup',
    resolveSafePath: null,
    sanitizeClientError: null,
    // Retorna Map relPath -> conteúdo atual (filtra IGNORED_DIRS/binários/limite).
    projectFileContents: () => new Map()
};

function configureSnapshot(deps) {
    Object.assign(ctx, deps);
}

function snapshotRoot() {
    return path.join(ctx.getProjectRoot(), ctx.backupDirName(), 'snapshots');
}

function sanitizeLabel(label) {
    const s = String(label || '').trim().replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, '_');
    return s.slice(0, 80) || 'snapshot';
}

function snapshotAll() {
    return ctx.projectFileContents();
}

// Retorna o conteúdo de um arquivo dentro de um snapshot, de forma segura.
function readSnapshotFile(dir, relPath) {
    const target = path.resolve(dir, relPath);
    if (target !== dir && !target.startsWith(dir + path.sep)) return null;
    if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) return null;
    return fs.readFileSync(target, 'utf-8');
}

// Lista os caminhos (relPath) presentes dentro de um snapshot.
function walkSnapshotFiles(dir) {
    const out = [];
    walkProjectFiles(dir, (f) => {
        if (f.name === '.meta.json') return;
        out.push(f.relPath);
    }, { ignoredDirs: new Set(), maxFiles: Infinity });
    return out;
}

// Restaura um snapshot rotulado por cima do projeto atual. Retorna o nº de arquivos.
function restoreSnapshot(label) {
    const root = snapshotRoot();
    const dir = path.join(root, label);
    if (!dir.startsWith(root) || !fs.existsSync(dir)) throw new Error('Snapshot não encontrado');
    let restored = 0;
    for (const rel of walkSnapshotFiles(dir)) {
        const src = path.join(dir, rel);
        const target = ctx.resolveSafePath(rel);
        if (!target) continue;
        try {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.copyFileSync(src, target);
            restored++;
        } catch (e) {}
    }
    return restored;
}

function registerSnapshotRoutes(app) {
    app.post('/api/snapshot/create', (req, res) => {
        const { name, note } = req.body;
        const label = sanitizeLabel(name);
        const dir = path.join(snapshotRoot(), label);
        try {
            // se já existe, apaga para renomear a versão nova
            fs.rmSync(dir, { recursive: true, force: true });
            const files = snapshotAll();
            let copied = 0;
            for (const [relPath] of files) {
                const full = ctx.resolveSafePath(relPath);
                if (!full || !fs.existsSync(full)) continue;
                const target = path.join(dir, relPath);
                fs.mkdirSync(path.dirname(target), { recursive: true });
                try {
                    fs.copyFileSync(full, target);
                    copied++;
                } catch { /* ignora inúmeros */ }
            }
            fs.writeFileSync(path.join(dir, '.meta.json'), JSON.stringify({
                name: label, note: note || '', createdAt: Date.now(), files: copied
            }, null, 2));
            res.json({ success: true, message: `Snapshot "${label}" criado (${copied} arquivos)`, name: label });
        } catch (e) {
            res.status(500).json({ error: ctx.sanitizeClientError(e) });
        }
    });

    app.post('/api/snapshot/list', (req, res) => {
        const root = snapshotRoot();
        const list = [];
        if (fs.existsSync(root)) {
            for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
                if (!entry.isDirectory()) continue;
                const metaPath = path.join(root, entry.name, '.meta.json');
                let meta = { name: entry.name, note: '', createdAt: null, files: 0 };
                try {
                    if (fs.existsSync(metaPath)) meta = { ...meta, ...JSON.parse(fs.readFileSync(metaPath, 'utf-8')) };
                    else meta.createdAt = fs.statSync(path.join(root, entry.name)).mtimeMs;
                } catch {}
                list.push(meta);
            }
        }
        list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        res.json({ success: true, snapshots: list });
    });

    app.post('/api/snapshot/diff', (req, res) => {
        const { name } = req.body;
        const label = sanitizeLabel(name);
        const root = snapshotRoot();
        const dir = path.join(root, label);
        if (!dir.startsWith(root) || !fs.existsSync(dir)) {
            return res.status(404).json({ error: 'Snapshot não encontrado' });
        }
        const changes = { modified: [], created: [], deleted: [], unchanged: 0 };
        const snapFiles = walkSnapshotFiles(dir);

        // arquivos no snapshot comparados com o projeto atual
        for (const rel of snapFiles) {
            const snapContent = readSnapshotFile(dir, rel);
            const full = ctx.resolveSafePath(rel);
            if (!full || !fs.existsSync(full)) {
                changes.deleted.push(rel); // existe no snapshot, não existe agora
                continue;
            }
            const cur = fs.readFileSync(full, 'utf-8');
            if (snapContent === null || snapContent === cur) changes.unchanged++;
            else changes.modified.push(rel);
        }
        // arquivos atuais que não existem no snapshot (criados depois)
        const currentFiles = snapshotAll();
        for (const rel of currentFiles.keys()) {
            const target = path.join(dir, rel);
            if (!fs.existsSync(target)) changes.created.push(rel);
        }
        res.json({ success: true, name: label, changes });
    });

    // Restaura um snapshot rotulado por cima do projeto atual.
    app.post('/api/snapshot/restore', (req, res) => {
        const { name } = req.body;
        const label = sanitizeLabel(name);
        const root = snapshotRoot();
        const dir = path.join(root, label);
        if (!dir.startsWith(root) || !fs.existsSync(dir)) {
            return res.status(404).json({ error: 'Snapshot não encontrado' });
        }
        let restored = 0;
        for (const rel of walkSnapshotFiles(dir)) {
            const src = path.join(dir, rel);
            const target = ctx.resolveSafePath(rel);
            if (!target) continue;
            try {
                fs.mkdirSync(path.dirname(target), { recursive: true });
                fs.copyFileSync(src, target);
                restored++;
            } catch {}
        }
        res.json({ success: true, message: `Snapshot "${label}" restaurado (${restored} arquivos)`, restored });
    });
}

module.exports = { configureSnapshot, registerSnapshotRoutes, restoreSnapshot, sanitizeLabel, walkSnapshotFiles, readSnapshotFile };
