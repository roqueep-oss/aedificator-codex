// Funções puras de tradução/classificação de erros de provedores e opencode.
// Extraídas de server.js — não dependem de nenhum estado global do servidor.

function _errorHint(statusCode, errorBody, provider) {
    const msg = (typeof errorBody === 'string' ? errorBody : (errorBody && errorBody.message || '')).toLowerCase();
    if (statusCode === 401 || msg.includes('invalid api key') || msg.includes('incorrect api key') || msg.includes('unauthorized'))
        return `🔑 Chave API ${provider.toUpperCase()} inválida. Verifique em Configurações.`;
    if (statusCode === 402 || msg.includes('insufficient_quota') || msg.includes('billing') || msg.includes('credit') || msg.includes('balance'))
        return `💰 Créditos ${provider.toUpperCase()} esgotados. Recarregue no site do provedor.`;
    if (statusCode === 429 || msg.includes('rate limit') || msg.includes('too many requests'))
        return `⏳ Limite de requisições ${provider.toUpperCase()} atingido. Aguarde alguns minutos.`;
    if (statusCode === 403 || msg.includes('forbidden') || msg.includes('region'))
        return `🚫 Acesso negado à API ${provider.toUpperCase()}. Verifique permissões e região.`;
    if (statusCode >= 500)
        return `🔥 Servidor ${provider.toUpperCase()} instável. Tente novamente em alguns segundos.`;
    return '';
}

function getProviderErrorHint(statusCode, errorBody, provider) {
    return _errorHint(statusCode, errorBody, provider);
}

function friendlyOpenCodeError(raw) {
    const msg = String(raw || '').trim();
    if (!msg) return 'opencode não retornou resposta';
    if (/unexpected server error/i.test(msg)) return 'O gateway opencode (Zen) retornou um erro de servidor. Tente novamente em instantes ou use outro modelo/provedor.';
    if (/rate\s*limit|429|quota|exceeded/i.test(msg)) return 'Limite de uso do opencode atingido. Aguarde alguns minutos ou troque de modelo.';
    if (/auth|unauthorized|401|api ?key|login/i.test(msg)) return 'Falha de autenticação do opencode. Verifique a chave API em Configurações.';
    if (/model.*not found|invalid.*model|404/i.test(msg)) return 'Modelo opencode não encontrado. Escolha outro modelo no seletor.';
    return 'opencode erro: ' + msg;
}

function friendlyProviderError(provider, status, errorMsg) {
    const msg = (errorMsg || '').toLowerCase();
    if (/crédito|balance|insufficient|402/.test(msg)) {
        if (provider === 'gemini') return 'Créditos GEMINI esgotados. Recarregue no site do provedor ou use outro modelo.';
        if (provider === 'deepseek') return 'Créditos DEEPSEEK esgotados. Recarregue no site do provedor ou use outro modelo.';
        return `Créditos ${provider.toUpperCase()} esgotados. Recarregue ou use outro modelo.`;
    }
    if (/rate\s*limit|429|quota|exceeded/i.test(msg)) {
        if (provider === 'gemini') return 'Limite de uso do GEMINI atingido. Aguarde alguns minutos ou troque de modelo.';
        if (provider === 'deepseek') return 'Limite de uso do DEEPSEEK atingido. Aguarde alguns minutos ou troque de modelo.';
        return `Limite de uso do ${provider.toUpperCase()} atingido. Aguarde ou troque de modelo.`;
    }
    if (/auth|unauthorized|401/i.test(msg)) {
        if (provider === 'gemini') return 'Falha de autenticação do GEMINI. Verifique a chave API em Configurações.';
        if (provider === 'deepseek') return 'Falha de autenticação do DEEPSEEK. Verifique a chave API em Configurações.';
        return `Falha de autenticação do ${provider.toUpperCase()}. Verifique a chave API.`;
    }
    if (/model.*not found|invalid.*model|404/i.test(msg)) {
        if (provider === 'gemini') return 'Modelo GEMINI não encontrado. Selecione outro modelo no seletor.';
        if (provider === 'deepseek') return 'Modelo DEEPSEEK não encontrado. Selecione outro modelo no seletor.';
        return `Modelo ${provider.toUpperCase()} não encontrado. Selecione outro modelo.`;
    }
    return `${provider.toUpperCase()} erro: ${errorMsg || 'erro desconhecido'}`;
}

function isNetworkError(err) {
    const m = String((err && err.message) || '').toLowerCase();
    return /fetch failed|enetunreach|econnrefused|econnreset|etimedout|timeout|network|socket hang up|failed to fetch|temporary failure/i.test(m);
}

// Erros transitórios (rede, 429, 5xx, instabilidade) merecem retry; os demais
// (chave inválida, cota esgotada) não — retry só desperdiçaria tempo.
function isRetryableError(err) {
    if (isNetworkError(err)) return true;
    const m = String((err && err.message) || '').toLowerCase();
    return /429|500|502|503|504|rate ?limit|too many requests|timed ?out|temporarily|overloaded|inst[áa]vel|limite de requisi[çc][õo]es|tente novamente/i.test(m);
}

// Um erro é "elegível a fallback" quando o provider atual não consegue responder
// AGORA: falha de rede OU cota/limite/esgotamento OU instabilidade (5xx). Erros
// de chave inválida (401) são de configuração e não trocamos de provider sozinhos.
function isFallbackEligibleError(err) {
    if (isNetworkError(err)) return true;
    const m = String((err && err.message) || '').toLowerCase();
    return /esgotad|insufficient|quota|billing|credit|balance|rate ?limit|too many requests|exhausted|payment required|overloaded|service unavailable|\b402\b|\b429\b|\b500\b|\b502\b|\b503\b|\b504\b/i.test(m);
}

module.exports = { getProviderErrorHint, friendlyOpenCodeError, friendlyProviderError, isNetworkError, isRetryableError, isFallbackEligibleError };
