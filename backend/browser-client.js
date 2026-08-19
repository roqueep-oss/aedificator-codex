const { pathToFileURL } = require('url');
const fs = require('fs');

// O opencode usa browser real (Playwright) para ver o console e os erros de
// runtime — é assim que ele "sabe" o que corrigir. O Aedificator tenta usar
// Playwright; se não estiver instalado, cai para puppeteer-core com o
// Chrome/Edge já presente no Windows, mantendo a IA com acesso ao browser.
let chromium = null;
let engine = null;
try {
    chromium = require('playwright').chromium;
    engine = 'playwright';
} catch (e) {
    try {
        const puppeteer = require('puppeteer-core');
        chromium = puppeteer;
        engine = 'puppeteer';
    } catch (e2) {
        console.log('⚠️ Browser não disponível: instale playwright ou puppeteer-core');
    }
}

// Localiza um executável de Chrome/Edge no Windows para o puppeteer-core.
function findBrowserExecutable() {
    const candidates = [
        process.env.PROGRAMFILES + '\\Google\\Chrome\\Application\\chrome.exe',
        process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
        process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
        process.env.PROGRAMFILES + '\\Microsoft\\Edge\\Application\\msedge.exe',
        process.env['PROGRAMFILES(X86)'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
        process.env.LOCALAPPDATA + '\\Microsoft\\Edge\\Application\\msedge.exe'
    ];
    for (const c of candidates) { if (c && fs.existsSync(c)) return c; }
    return null;
}

class BrowserClient {
    constructor() {
        this.browser = null;
        this.page = null;
        this.connected = false;
        this.consoleLogs = [];
    }

    async ensureBrowser() {
        if (!chromium) throw new Error('Browser não instalado (playwright/puppeteer-core)');
        // puppeteer-core não expõe isConnected() como o Playwright
        const isAlive = this.browser && (typeof this.browser.isConnected === 'function' ? this.browser.isConnected() : true);
        if (isAlive && this.page) return;
        if (this.browser) { try { await this.browser.close(); } catch (e) {} }
        try {
            if (engine === 'puppeteer') {
                const exe = findBrowserExecutable();
                if (!exe) throw new Error('Nenhum Chrome/Edge encontrado no sistema');
                this.browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--no-sandbox'] });
                this.page = await this.browser.newPage();
            } else {
                this.browser = await chromium.launch({ headless: true });
                this.page = await this.browser.newPage();
            }
            this.consoleLogs = [];
            this.page.on('console', (msg) => {
                this.consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
                if (this.consoleLogs.length > 200) this.consoleLogs.shift();
            });
            this.page.on('pageerror', (err) => {
                this.consoleLogs.push(`[error] ${err.message}`);
            });
            this.connected = true;
            console.log('🌐 Browser conectado (' + engine + ')');
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
        if (engine === 'puppeteer') {
            await this.page.click(selector, { clickCount: 3 });
            await this.page.type(selector, text);
        } else {
            await this.page.fill(selector, text);
        }
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
