// Rotas de estado por projeto: settings, keybindings e tasks de build.
// Persistência em arquivos JSON dentro da raiz do projeto (.aedificator-*.json).
// Extraído de server.js; recebe app + ctx { getProjectRoot, sanitizeClientError }.

const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = (root) => path.join(root, '.aedificator-settings.json');
const KEYBINDINGS_FILE = (root) => path.join(root, '.aedificator-keybindings.json');
const TASKS_FILE = (root) => path.join(root, '.aedificator-tasks.json');

function registerStateRoutes(app, ctx) {
    const root = () => ctx.getProjectRoot();

    // ===== SETTINGS SYNC =====
    app.post('/api/settings/export', (req, res) => {
        if (!root()) return res.status(400).json({ error: 'Nenhum projeto aberto' });
        try {
            const { settings } = req.body || {};
            if (!settings && !req.body.id) return res.status(400).json({ error: 'Envie as configurações como { settings: {...} }' });
            const toSave = settings || req.body;
            toSave.exportedAt = new Date().toISOString();
            fs.writeFileSync(SETTINGS_FILE(root()), JSON.stringify(toSave, null, 2), 'utf-8');
            res.json({ success: true, file: '.aedificator-settings.json' });
        } catch (e) {
            res.status(500).json({ error: ctx.sanitizeClientError(e) });
        }
    });

    app.post('/api/settings/import', (req, res) => {
        if (!root()) return res.status(400).json({ error: 'Nenhum projeto aberto' });
        try {
            const file = SETTINGS_FILE(root());
            if (!fs.existsSync(file)) return res.status(404).json({ error: 'Arquivo .aedificator-settings.json não encontrado. Exporte primeiro.' });
            const settings = JSON.parse(fs.readFileSync(file, 'utf-8'));
            res.json({ success: true, settings });
        } catch (e) {
            res.status(500).json({ error: ctx.sanitizeClientError(e) });
        }
    });

    app.post('/api/keybindings/list', (req, res) => {
        if (!root()) return res.json({ success: true, bindings: [] });
        try {
            const file = KEYBINDINGS_FILE(root());
            let bindings = [];
            if (fs.existsSync(file)) {
                bindings = JSON.parse(fs.readFileSync(file, 'utf-8'));
            }
            res.json({ success: true, bindings });
        } catch (e) {
            res.json({ success: true, bindings: [] });
        }
    });

    app.post('/api/keybindings/save', (req, res) => {
        const { bindings } = req.body || {};
        if (!root() || !Array.isArray(bindings)) return res.status(400).json({ error: 'Dados inválidos' });
        try {
            fs.writeFileSync(KEYBINDINGS_FILE(root()), JSON.stringify(bindings, null, 2), 'utf-8');
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: ctx.sanitizeClientError(e) });
        }
    });

    // ===== TAREFAS DE BUILD =====
    app.post('/api/tasks/list', (req, res) => {
        const file = TASKS_FILE(root());
        let tasks = [];
        try {
            if (fs.existsSync(file)) {
                tasks = JSON.parse(fs.readFileSync(file, 'utf-8'));
            }
        } catch (e) {}
        res.json({ success: true, tasks });
    });

    app.post('/api/tasks/save', (req, res) => {
        const { tasks } = req.body;
        if (!Array.isArray(tasks)) return res.status(400).json({ error: 'Lista de tarefas inválida' });
        try {
            fs.writeFileSync(TASKS_FILE(root()), JSON.stringify(tasks, null, 2), 'utf-8');
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: ctx.sanitizeClientError(e) });
        }
    });
}

module.exports = { registerStateRoutes };
