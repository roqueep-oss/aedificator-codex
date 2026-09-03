// Rotas de configuração: /api/config e /api/config/permissions.
// Extraído de server.js. ctx: { config (objeto vivo), saveConfigToFile,
// syncOpenCodeProviderAuth, getOpenCodeAuthKey, ensureOpenCodeAuth,
// normalizeDeepseekModel, sanitizeClientError }.

function registerConfigRoutes(app, ctx) {
    const c = () => ctx.config;

    app.post('/api/config', (req, res) => {
        const { geminiKey, deepseekKey, opencodeKey, openaiKey, claudeKey, openaiModel, claudeModel, deepseekModel, autoCommit, memory, semanticSearch, inlineCompletion } = req.body;
        if (geminiKey && geminiKey !== '********') c().gemini.apiKey = geminiKey;
        if (deepseekKey && deepseekKey !== '********') c().deepseek.apiKey = deepseekKey;
        if (opencodeKey && opencodeKey !== '********') {
            c().opencode.apiKey = opencodeKey;
            ctx.ensureOpenCodeAuth(opencodeKey);
        }
        if (openaiKey && openaiKey !== '********') c().openai.apiKey = openaiKey;
        if (openaiModel) c().openai.model = openaiModel;
        if (claudeKey && claudeKey !== '********') c().claude.apiKey = claudeKey;
        if (claudeModel) c().claude.model = claudeModel;
        if (deepseekModel) c().deepseek.model = ctx.normalizeDeepseekModel(deepseekModel);
        if (autoCommit !== undefined) c().autoCommit = !!autoCommit;
        if (memory !== undefined) c().memory = !!memory;
        if (semanticSearch !== undefined) c().semanticSearch = !!semanticSearch;
        if (inlineCompletion !== undefined) c().inlineCompletion = !!inlineCompletion;

        try {
            ctx.saveConfigToFile();
            ctx.syncOpenCodeProviderAuth();
            res.json({ success: true, message: 'Configuração salva!' });
        } catch (e) {
            res.status(500).json({ error: ctx.sanitizeClientError(e) });
        }
    });

    app.get('/api/config/get', (req, res) => {
        res.json({
            success: true,
            gemini: c().gemini.apiKey ? '********' : '',
            deepseek: c().deepseek.apiKey ? '********' : '',
            opencode: c().opencode.apiKey || ctx.getOpenCodeAuthKey() ? '********' : '',
            openai: c().openai.apiKey ? '********' : '',
            claude: c().claude.apiKey ? '********' : '',
            openaiModel: c().openai.model || '',
            claudeModel: c().claude.model || '',
            deepseekModel: c().deepseek.model || 'deepseek-v4-flash',
            autoCommit: c().autoCommit,
            memory: !!c().memory,
            semanticSearch: !!c().semanticSearch,
            inlineCompletion: c().inlineCompletion !== false
        });
    });

    app.get('/api/config/status', (req, res) => {
        res.json({
            gemini: { configured: !!c().gemini.apiKey },
            deepseek: { configured: !!c().deepseek.apiKey },
            opencode: { configured: !!c().opencode.apiKey || !!ctx.getOpenCodeAuthKey() },
            openai: { configured: !!c().openai.apiKey },
            claude: { configured: !!c().claude.apiKey }
        });
    });

    app.get('/api/config/permissions', (req, res) => {
        res.json({ success: true, ask: c().toolPermissions.ask || [], grants: c().toolPermissions.grants || {} });
    });

    app.post('/api/config/permissions', (req, res) => {
        const { ask } = req.body || {};
        if (Array.isArray(ask)) c().toolPermissions.ask = ask;
        try {
            ctx.saveConfigToFile();
            res.json({ success: true, ask: c().toolPermissions.ask, grants: c().toolPermissions.grants });
        } catch (e) {
            res.status(500).json({ error: ctx.sanitizeClientError(e) });
        }
    });

    app.post('/api/config/permissions/reset', (req, res) => {
        c().toolPermissions.grants = {};
        try {
            ctx.saveConfigToFile();
            res.json({ success: true, message: 'Permissões resetadas' });
        } catch (e) {
            res.status(500).json({ error: ctx.sanitizeClientError(e) });
        }
    });
}

module.exports = { registerConfigRoutes };
