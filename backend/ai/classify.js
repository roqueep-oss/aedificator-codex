'use strict';
// =============================================
//  CLASSIFICAÇÃO DE INTENÇÃO DO PEDIDO
//  Funções puras: pergunta / tarefa / recomendação.
//  Sem dependência do restante do servidor.
// =============================================

function stripAccents(s) {
    return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Pedido de recomendação/opinião sobre O QUE FAZER — não é pergunta de explicação
// ("o que é X") nem diretiva clara ("melhore X"). Deve gerar OPÇÕES para o usuário
// escolher (ex.: "qual melhoria é mais importante", "sugira melhorias").
const RECOMMENDATION_RE = /(melhoria|melhorias|sugira|sugerir|sugestao|sugestoes|recomende|recomendar|recomendacao|recomendacoes|o que posso|o que devo|o que falta|o que adicionar|o que implementar|o que melhorar|qual a melhor|qual e a melhor|melhor opcao|que funcionalidade|qual funcionalidade|que recurso|qual recurso|que feature|qual feature|ideia para|ideias para|ideia de|ideias de)/i;

function classifyIntent(message) {
    const m = stripAccents((message || '').toLowerCase()).trim();
    // "O que posso/devo/falta fazer" é pedido de recomendação (o que fazer), não
    // pergunta de explicação — verificado ANTES da regra "o que ..." genérica.
    if (/(o que posso|o que devo|o que falta|o que adicionar|o que implementar|o que melhorar|o que poderia|o que eu deveria|o que eu posso|o que devemos|o que pode melhorar|o que pode ser melhorado|o que posso melhorar|o que da para melhorar|o que dá para melhorar|o que poderia ser melhorado|o que eu posso melhorar|o que você recomendaria|o que voce recomendaria|o que sugeriria|o que você sugeriria|o que voce sugeriria|como posso melhorar|como posso otimizar|como posso aprimorar)/i.test(m)) return 'task';
    if (/(^|\s)(o que e|o que|como funciona|explique|qual a diferenca|defina|conceito|significado|what is|whats|how does|how do|explain|what'?s the difference|define|meaning|que es|cual es|diferencia)\b/i.test(m)) return 'question';
    // Relato de bug/erro NÃO é pergunta: "quando abro o app ele trava",
    // "o botão X não funciona", "fica replicando o loop" pedem CORREÇÃO, não
    // explicação. Roda DEPOIS da regra de explicação (que continua vencendo
    // para perguntas genuínas como "o que é esse erro?").
    if (/(nao funciona|nao esta funcionando|nao funciona mais|parou de funcionar|parou de responder|para de funcionar|nao consigo|nao da certo|quebrad|broken|roto|rompi|trava|travando|travou|congela|congelando|crash|freeze|freezing|hang|falha|falhando|falhou|fails|failing|failed|failure|bug|bugado|bugada|defeito|defect|erro|erros|error|errors|exception|excecao|loop|infinito|infinite|replicando|repetindo|repeating|duplicando|duplicating|nao abre|nao carrega|nao salva|nao responde|nao roda|nao executa|nao inicia|nao conecta|sumiu|desapareceu|desaparece|disappear|vanish|corrompid|corrupt|tela branca|tela preta|white screen|black screen|sem resposta|not working|doesn'?t work|does not work|is broken|isn'?t working|dont work|stopped working)/i.test(m)) return 'task';
    // Pedido de recomendação → 'task' (não é pergunta; classifyRequest roteia para opções).
    if (RECOMMENDATION_RE.test(m)) return 'task';
    if (/^(o que|como|qual|quais|por que|quando|onde|quem|what|how|why|when|where|which|who|que|cual|cuales|cuando|donde|porque)\b/i.test(m)) return 'question';
    if (m.endsWith('?') && !/(crie|criar|cria|faca|fazer|implemente|implementar|corrija|corrigir|arrume|arrumar|adicione|adicionar|mude|mudar|altere|alterar|delete|deletar|remova|remover|refatore|refatorar|escreva|escrever|build|code|codigo|arquivo|file|funcao|function|componente|component|roda|rode|execute|executar|teste|testar|create|make|fix|add|remove|rename|update|refactor|write|implement|change|modify|crea|crear|corrige|anade|agregar|elimina|renombra|actualiza|refactoriza|escribe|implementa)\b/i.test(m)) return 'question';
    if (m.length < 15 && m.endsWith('?')) return 'question';
    return 'task';
}

function classifyRequest(message) {
    const m = (message || '').trim();
    const mLower = stripAccents(m).toLowerCase();

    const intent = classifyIntent(message);

    if (intent === 'question') return { route: 'answer', reason: 'Pergunta detectada' };

    const simplePatterns = [
        /^(corrig(a|ir)|arrum(a|ar)|consert(a|ar)|fix|correg(i|ir)|arregla(r)?)\s/i,
        /^(adicione|adicionar|acrescent(a|ar)|inclu(a|ir)|add)\s.+\s(no|na|em|ao|to|in|into|on|a|en)\s/i,
        /^(remova|remover|delete|deletar|apag(a|ar)|exclu(a|ir)|remove|elimina(r)?|borra(r)?)\s/i,
        /^(renomei(a|ar)|renomear|mova|mover|move|rename)\s/i,
        /^(troque|trocar|altere|alterar|mude|mudar|substitua|substituir|replace|change)\s.+\s(por|para|with|for|to)\s/i,
        /^(crie|criar|faca|fazer|implemente|implementar|create|make|implement|crea(r)?|crear|implementa(r)?)\s.+\s(com|usando|que|with|using|that)\s/i,
        /^(execute|executar|rode|rodar|teste|testar|run|test|ejecuta(r)?|ejecutar|prueba(r)?)\s/i,
        /^(atualize|atualizar|refatore|refatorar|update|refactor|actualiza(r)?|actualizar|refactoriza(r)?)\s\w+\s/i,
        /^(formate|formatar|lint|organize|organizar|format|organiza(r)?)\s/i,
        /^(adicione|adicionar|coloque|colocar|ponha|pôr|add|put|agrega(r)?)\s.+\s(no|na|antes|depois|após|to|in|before|after|en|antes|despues)\s/i,
        /^(extraia|extrair|separe|separar|divida|dividir|extract|split)\s/i,
        /^(converta|converter|transforme|transformar|convert|transform)\s/i,
    ];

    for (const pattern of simplePatterns) {
        if (pattern.test(mLower)) return { route: 'direct', reason: 'Tarefa específica detectada' };
    }

    // Pedido de recomendação/opinião sobre O QUE FAZER ("qual melhoria é mais
    // importante", "sugira melhorias") → gerar OPÇÕES para o usuário escolher,
    // em vez de apenas responder em texto ou executar no escuro.
    if (RECOMMENDATION_RE.test(mLower)) return { route: 'options', reason: 'Pedido de recomendação — gerar opções' };

    const complexSignals = [
        /\?/g,
        /\b(ou|ou então|alternativa|opção|opções|escolha|escolher|qual|como|or|option|options|choice|choose|which|how|o|opcion|opciones|eleccion|elegir|cual)\b/gi,
        /\b(qualquer|tanto faz|decida|decidir|sugira|sugerir|recomende|recomendar|any|either|decide|suggest|recommend|cualquiera|da igual|decidir|sugiere|recomienda)\b/gi,
        /\b(melhorar|melhore|aprimorar|aprimore|otimizar|otimize|improve|enhance|optimize|optimise|mejorar|optimizar)\b/gi,
    ];
    let complexityScore = 0;
    for (const sig of complexSignals) {
        const matches = mLower.match(sig);
        if (matches) complexityScore += matches.length;
    }

    if (mLower.length < 30) complexityScore += 3;
    if (/(melhorar|improve|mejorar)/.test(mLower) && !/(arquivo|funcao|file|function|archivo)/.test(mLower)) complexityScore += 2;
    if (mLower.split(/\s+/).length > 40) complexityScore -= 2;

    if (complexityScore >= 3) return { route: 'options', reason: 'Pedido complexo/aberto — gerar opções' };

    if (mLower.length > 100 || mLower.split(',').length > 3 || mLower.split(';').length > 2) {
        return { route: 'direct', reason: 'Múltiplas tarefas específicas' };
    }

    return { route: 'direct', reason: 'Tarefa direta padrão' };
}

module.exports = { stripAccents, classifyIntent, classifyRequest, RECOMMENDATION_RE };
