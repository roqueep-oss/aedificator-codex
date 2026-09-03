// Rotas de projeto e de execução de testes: rules, summary e test discover/run.
// Extraído de server.js. ctx: { getProjectRoot, ignoredDirs, sanitizeClientError,
// detectBuildCommands, detectTestFramework }.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { walkProjectFiles } = require('./project-files');
const { parseTestOutput } = require('./test-output');

const AGENTS_FILE = '.aedificator-agents.md';

function registerProjectRoutes(app, ctx) {
    const root = () => ctx.getProjectRoot();

    app.get('/api/project/rules', (req, res) => {
        const filePath = path.join(root(), AGENTS_FILE);
        const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
        const defaultTemplate = `# Regras do Projeto\n\n## REGRA DE OURO\n- Pode melhorar o código (refatorar, otimizar, limpar), mas TODAS as funções existentes devem CONTINUAR FUNCIONANDO.\n- Melhore a qualidade sem alterar o comportamento.\n- Se uma função recebe X e retorna Y, continue recebendo X e retornando Y — mesmo que o código interno mude.\n\n## Convenções de Código\n- Use ponto e vírgula\n- Prefira const a let\n- Use arrow functions\n\n## Arquitetura\n- Separe lógica de negócio da UI\n\n## Preferências\n- Prefira alterações mínimas e seguras\n`;
        res.json({ success: true, content: content || defaultTemplate, exists: fs.existsSync(filePath) });
    });

    app.post('/api/project/rules', (req, res) => {
        const filePath = path.join(root(), AGENTS_FILE);
        try {
            fs.writeFileSync(filePath, ((req.body.content || '').trim() || '') + '\n', 'utf-8');
            res.json({ success: true, path: AGENTS_FILE });
        } catch (e) {
            res.status(500).json({ error: ctx.sanitizeClientError(e) });
        }
    });

    // ===== ENDPOINT: PROJECT SUMMARY =====
    app.post('/api/project/summary', (req, res) => {
        if (!root()) return res.json({ success: false, error: 'Nenhum projeto aberto' });
        try {
            const extCounts = {};
            let totalFiles = 0;
            walkProjectFiles(root(), (f) => {
                totalFiles++;
                const ext = path.extname(f.name).toLowerCase();
                extCounts[ext] = (extCounts[ext] || 0) + 1;
            }, { ignoredDirs: ctx.ignoredDirs, maxFiles: Infinity });
            const buildCommands = ctx.detectBuildCommands();
            const testFramework = ctx.detectTestFramework();
            const pkgPath = path.join(root(), 'package.json');
            let pkgName = '', pkgVersion = '';
            if (fs.existsSync(pkgPath)) {
                try { const p = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')); pkgName = p.name || ''; pkgVersion = p.version || ''; } catch (e) {}
            }
            res.json({
                success: true,
                projectRoot: root(),
                name: pkgName || path.basename(root()),
                version: pkgVersion,
                totalFiles,
                languages: extCounts,
                buildCommands,
                testFramework: testFramework ? testFramework.command : null,
                timestamp: new Date().toISOString()
            });
        } catch (e) { res.status(500).json({ error: ctx.sanitizeClientError(e) }); }
    });

    // =============================================
    //  TEST RUNNER
    // =============================================
    app.post('/api/test/discover', (req, res) => {
        const testPatterns = [/\.test\.(js|ts|jsx|tsx|mjs|cjs)$/i, /\.spec\.(js|ts|jsx|tsx|mjs|cjs)$/i, /__tests__\/.*\.(js|ts|jsx|tsx)$/i];
        const results = [];
        walkProjectFiles(root(), (f) => {
            if (testPatterns.some(p => p.test(f.name))) {
                results.push(f.relPath);
            }
        }, { ignoredDirs: ctx.ignoredDirs, maxFiles: Infinity });
        res.json({ success: true, tests: results });
    });

    app.post('/api/test/run', async (req, res) => {
        const { command } = req.body || {};
        const cmdStr = command || 'node --test';
        const [cmd, ...args] = cmdStr.split(/\s+/);
        try {
            const proc = spawn(cmd, args, { cwd: root(), shell: true });
            let output = '';
            proc.stdout.on('data', (d) => { output += d.toString('utf8'); });
            proc.stderr.on('data', (d) => { output += d.toString('utf8'); });
            proc.on('close', (code) => {
                res.json({
                    success: true,
                    exitCode: code,
                    output,
                    results: parseTestOutput(output)
                });
            });
            proc.on('error', (err) => {
                res.json({ success: false, error: err.message });
            });
        } catch (e) {
            res.status(500).json({ error: ctx.sanitizeClientError(e) });
        }
    });
}

module.exports = { registerProjectRoutes };
