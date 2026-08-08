let chromium = null;
try { chromium = require('playwright').chromium; } catch (e) {
    console.log('🌐 Playwright não instalado. Execute: npm install playwright');
}

class BrowserClient {
    constructor() {
        this.browser = null;
        this.page = null;
        this.connected = false;
        this.consoleLogs = [];
    }

    async ensureBrowser() {
        if (!chromium) throw new Error('Playwright não instalado');
        if (this.browser && this.browser.isConnected()) return;
        try {
            this.browser = await chromium.launch({ headless: true });
            this.page = await this.browser.newPage();
            this.consoleLogs = [];
            this.page.on('console', (msg) => {
                this.consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
                if (this.consoleLogs.length > 200) this.consoleLogs.shift();
            });
            this.page.on('pageerror', (err) => {
                this.consoleLogs.push(`[error] ${err.message}`);
            });
            this.connected = true;
            console.log('🌐 Browser Playwright conectado');
        } catch (e) {
            console.error('🌐 Browser não disponível:', e.message);
            this.connected = false;
            this.browser = null;
            this.page = null;
        }
    }

    async navigate(url) {
        await this.ensureBrowser();
        if (!this.page) throw new Error('Browser não disponível');
        await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        return 'Navegou para ' + url;
    }

    async screenshot() {
        await this.ensureBrowser();
        if (!this.page) throw new Error('Browser não disponível');
        const buf = await this.page.screenshot({ encoding: 'base64', fullPage: false });
        return buf.slice(0, 100000) + (buf.length > 100000 ? '...(truncado)' : '');
    }

    async click(selector) {
        await this.ensureBrowser();
        if (!this.page) throw new Error('Browser não disponível');
        await this.page.waitForSelector(selector, { timeout: 5000 });
        await this.page.click(selector);
        return 'Clicado em ' + selector;
    }

    async typeText(selector, text) {
        await this.ensureBrowser();
        if (!this.page) throw new Error('Browser não disponível');
        await this.page.waitForSelector(selector, { timeout: 5000 });
        await this.page.fill(selector, text);
        return 'Digitado em ' + selector;
    }

    async evaluate(js) {
        await this.ensureBrowser();
        if (!this.page) throw new Error('Browser não disponível');
        const result = await this.page.evaluate(js);
        return String(result).slice(0, 5000);
    }

    async getContent() {
        return await this.evaluate('document.body ? document.body.innerText.slice(0, 5000) : "Sem conteúdo"');
    }

    async getConsole() {
        if (!this.page) return '(browser não conectado)';
        return this.consoleLogs.slice(-50).join('\n') || '(sem logs)';
    }

    async close() {
        if (this.browser) {
            try { await this.browser.close(); } catch (e) {}
            this.browser = null;
            this.page = null;
            this.connected = false;
            this.consoleLogs = [];
        }
    }
}

const browserClient = new BrowserClient();

function getBrowserStatus() {
    return { connected: browserClient.connected };
}

async function executeBrowserTool(name, args) {
    try {
        switch (name) {
            case 'browser_navigate': return await browserClient.navigate(args.url || '');
            case 'browser_screenshot': return await browserClient.screenshot();
            case 'browser_content': return await browserClient.getContent();
            case 'browser_click': return await browserClient.click(args.selector || '');
            case 'browser_type': return await browserClient.typeText(args.selector || '', args.text || '');
            case 'browser_evaluate': return await browserClient.evaluate(args.js || '');
            case 'browser_console': return await browserClient.getConsole();
            default: return 'Ferramenta de browser desconhecida';
        }
    } catch (e) {
        return 'Erro Browser: ' + e.message;
    }
}

module.exports = { browserClient, getBrowserStatus, executeBrowserTool };
