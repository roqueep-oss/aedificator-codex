// Histórico undo/redo + backups de arquivos. Extraído de server.js.
// O estado (pilhas) vive aqui; o server injeta as dependências dinâmicas via
// setHistoryCtx (resolveSafePath, broadcastAll, listBackups, getProjectRoot...).

const fs = require('fs');
const path = require('path');

const undoStack = [];
const redoStack = [];

const ctx = {
    getProjectRoot: () => null,
    resolveSafePath: null,
    sanitizeClientError: null,
    listBackups: () => [],
    broadcastAll: () => {}
};

function setHistoryCtx(d) {
    Object.assign(ctx, d);
}

function pushUndoState(affectedFiles) {
    if (!Array.isArray(affectedFiles) || !affectedFiles.length) return;
    const entry = { timestamp: Date.now(), files: [] };
    for (const f of affectedFiles) {
        const fullPath = ctx.resolveSafePath(typeof f === 'string' ? f : f.caminho || f.file);
        if (!fullPath || !fs.existsSync(fullPath)) continue;
        try {
            entry.files.push({ path: typeof f === 'string' ? f : f.caminho || f.file, content: fs.readFileSync(fullPath, 'utf-8') });
        } catch (e) {}
    }
    if (entry.files.length) {
        undoStack.push(entry);
        if (undoStack.length > 50) undoStack.shift();
        redoStack.length = 0;
    }
}

// Captura o conteúdo atual dos arquivos de um entry (para a pilha oposta).
function captureFiles(entry) {
    const files = [];
    for (const f of entry.files) {
        const fullPath = ctx.resolveSafePath(f.path);
        if (!fullPath) continue;
        try {
            if (fs.existsSync(fullPath)) {
                files.push({ path: f.path, content: fs.readFileSync(fullPath, 'utf-8') });
            }
        } catch (e) {}
    }
    return files;
}

// Grava o conteúdo de um entry por cima do projeto.
function applyEntry(entry) {
    for (const f of entry.files) {
        const fullPath = ctx.resolveSafePath(f.path);
        if (!fullPath) continue;
        try {
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            fs.writeFileSync(fullPath, f.content, 'utf-8');
        } catch (e) {}
    }
}

function undoStep() {
    if (!undoStack.length) return null;
    const entry = undoStack.pop();
    const redoEntry = { timestamp: Date.now(), files: captureFiles(entry) };
    applyEntry(entry);
    if (redoEntry.files.length) redoStack.push(redoEntry);
    ctx.broadcastAll({ type: 'refresh' });
    return entry.files.length;
}

function redoStep() {
    if (!redoStack.length) return null;
    const entry = redoStack.pop();
    const undoEntry = { timestamp: Date.now(), files: captureFiles(entry) };
    applyEntry(entry);
    if (undoEntry.files.length) undoStack.push(undoEntry);
    ctx.broadcastAll({ type: 'refresh' });
    return entry.files.length;
}

async function undoLastChange() {
    const count = undoStep();
    return count === null ? null : `${count} arquivo(s) restaurado(s)`;
}

async function redoLastChange() {
    const count = redoStep();
    return count === null ? null : `${count} arquivo(s) refeito(s)`;
}

function registerHistoryRoutes(app) {
    // ===== BACKUP / RESTAURAR =====
    app.post('/api/backup/list', (req, res) => {
        res.json({ success: true, files: ctx.listBackups() });
    });

    app.post('/api/backup/restore', (req, res) => {
        const { file } = req.body;
        if (!file) return res.status(400).json({ error: 'Arquivo não especificado' });

        const backupFile = path.join(ctx.getProjectRoot(), '.aedificator-codex-ide-backup', file);
        if (!fs.existsSync(backupFile) || fs.statSync(backupFile).isDirectory()) {
            return res.status(404).json({ error: 'Backup não encontrado' });
        }

        const targetRel = file.replace(/\.\d+$/, '');
        const safeTarget = ctx.resolveSafePath(targetRel);
        if (!safeTarget) return res.status(400).json({ error: 'Caminho fora do projeto' });

        try {
            fs.mkdirSync(path.dirname(safeTarget), { recursive: true });
            fs.copyFileSync(backupFile, safeTarget);
            res.json({ success: true, message: 'Arquivo restaurado!', path: targetRel });
        } catch (e) {
            res.status(500).json({ error: ctx.sanitizeClientError(e) });
        }
    });

    // ===== UNDO / REDO =====
    app.post('/api/undo', (req, res) => {
        const count = undoStep();
        if (count === null) return res.json({ success: false, message: 'Nada para desfazer' });
        ctx.broadcastAll({ type: 'undo-done', message: `${count} arquivo(s) restaurado(s)` });
        res.json({ success: true, files: count, message: `${count} arquivo(s) restaurado(s)` });
    });

    app.post('/api/redo', (req, res) => {
        const count = redoStep();
        if (count === null) return res.json({ success: false, message: 'Nada para refazer' });
        ctx.broadcastAll({ type: 'redo-done', message: `${count} arquivo(s) refeito(s)` });
        res.json({ success: true, files: count, message: `${count} arquivo(s) refeito(s)` });
    });

    app.post('/api/undo/status', (req, res) => {
        res.json({ canUndo: undoStack.length > 0, canRedo: redoStack.length > 0, undoCount: undoStack.length, redoCount: redoStack.length });
    });
}

module.exports = { setHistoryCtx, registerHistoryRoutes, pushUndoState, undoLastChange, redoLastChange, undoStack, redoStack };
