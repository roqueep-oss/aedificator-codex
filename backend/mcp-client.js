const { spawn } = require('child_process');

class McpClient {
    constructor(serverConfig) {
        this.config = serverConfig;
        this.process = null;
        this.requestId = 0;
        this.pending = new Map();
        this.tools = [];
        this.buffer = '';
    }

    async start() {
        const { command, args = [], env = {} } = this.config;
        const safeArgs = Array.isArray(args) ? args : String(args || '').split(/\s+/).filter(Boolean);
        if (!command) throw new Error(`MCP server '${this.config.name}' sem comando definido`);

        this.process = spawn(command, safeArgs, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, ...env }
        });

        const spawnErrorPromise = new Promise((_, reject) => {
            this.process.on('error', (err) => reject(err));
            this.process.on('exit', (code) => {
                if (code !== 0 && code !== null) reject(new Error(`Processo MCP ${this.config.name} encerrou com código ${code}`));
            });
        });

        this.process.stdout.on('data', (data) => this._onData(data.toString()));
        this.process.stderr.on('data', (d) => console.error(`[mcp:${this.config.name}] stderr:`, d.toString().slice(0, 200)));

        await Promise.race([
            this._send('initialize', {
                protocolVersion: '2024-11-05',
                capabilities: {},
                clientInfo: { name: 'aedificator-codex', version: '1.0.0' }
            }),
            spawnErrorPromise
        ]);

        const toolsResult = await Promise.race([
            this._send('tools/list', {}),
            spawnErrorPromise
        ]);
        this.tools = (toolsResult.tools || []).map(t => ({
            name: `mcp_${this.config.name}_${t.name}`,
            description: t.description || `MCP tool: ${t.name}`,
            parameters: t.inputSchema?.properties || {},
            originalName: t.name
        }));

        console.log(`[mcp:${this.config.name}] ${this.tools.length} ferramentas carregadas`);
        return this.tools;
    }

    async callTool(originalName, args) {
        const result = await this._send('tools/call', { name: originalName, arguments: args });
        const content = result.content || [];
        return content.map(c => c.text || JSON.stringify(c)).join('\n').slice(0, 8000);
    }

    async _send(method, params) {
        const id = ++this.requestId;
        const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
        this.process.stdin.write(msg);

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`MCP timeout: ${method}`));
            }, 30000);
            this.pending.set(id, { resolve, reject, timer });
        });
    }

    _onData(chunk) {
        this.buffer += chunk;
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() || '';
        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const msg = JSON.parse(line);
                if (msg.id && this.pending.has(msg.id)) {
                    const { resolve, reject, timer } = this.pending.get(msg.id);
                    clearTimeout(timer);
                    this.pending.delete(msg.id);
                    if (msg.error) reject(new Error(msg.error.message || 'MCP error'));
                    else resolve(msg.result);
                }
            } catch (e) {}
        }
    }

    async stop() {
        for (const [, { reject }] of this.pending) reject(new Error('MCP stopped'));
        this.pending.clear();
        if (this.process) { this.process.kill(); this.process = null; }
    }
}

class McpManager {
    constructor() {
        this.clients = new Map();
    }

    async connectServers(configs) {
        for (const cfg of configs) {
            if (!cfg.enabled) continue;
            try {
                const client = new McpClient(cfg);
                const tools = await client.start();
                this.clients.set(cfg.name, { client, tools });
            } catch (e) {
                console.error(`[mcp] Falha ao conectar ${cfg.name}:`, e.message);
            }
        }
    }

    getAllTools() {
        const all = [];
        for (const [, { tools }] of this.clients) {
            for (const t of tools) all.push(t);
        }
        return all;
    }

    async executeTool(fullName, args) {
        for (const [, { client, tools }] of this.clients) {
            const tool = tools.find(t => t.name === fullName);
            if (tool) return await client.callTool(tool.originalName, args);
        }
        throw new Error(`Ferramenta MCP não encontrada: ${fullName}`);
    }

    async stopAll() {
        for (const [, { client }] of this.clients) {
            try { await client.stop(); } catch (e) {}
        }
        this.clients.clear();
    }
}

module.exports = { McpManager };
