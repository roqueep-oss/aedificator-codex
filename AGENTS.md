# Regras de Ouro — Aedificator Codex

Estas são as regras fundamentais que devem guiar toda construção, criação, correção, alteração e upgrade de código. Siga-as rigorosamente.

## Princípios Fundamentais

### KISS (Keep It Simple, Stupid)
Priorize a simplicidade. Escreva o código mais simples que resolva o problema. Evite complexidade desnecessária, padrões rebuscados ou abstrações prematuras.

### DRY (Don't Repeat Yourself)
Cada pedaço de conhecimento ou lógica deve ter uma representação única no sistema. Se houver código duplicado, abstraia-o em uma função, classe ou módulo reutilizável.

### YAGNI (You Aren't Gonna Need It)
Não implemente funcionalidades pensando no futuro se não precisa delas agora. Escreva apenas o necessário para a demanda atual. Código a menos é melhor que código a mais.

### Boy Scout Rule
Deixe o código mais limpo do que como você o encontrou. Sempre que mexer em um arquivo, faça uma pequena melhoria: renomeie uma variável mal nomeada, extraia uma função, remova código morto, adicione um teste.

## Legibilidade e Organização

### Nomes significativos
Variáveis, funções e classes devem revelar sua intenção. Use nomes claros e descritivos.
- ✅ `calcular_total_imposto()`, `usuario_autenticado`, `MAX_TENTATIVAS_LOGIN`
- ❌ `calc()`, `x`, `data`, `temp`, `obj`

### Funções pequenas e de responsabilidade única
Uma função deve fazer apenas uma coisa, fazê-la bem e ser a única a fazê-la (alinhado ao SRP do SOLID).
- Máximo recomendado: 10-20 linhas por função.
- Se a função faz mais de uma coisa, divida-a.

### Evite comentários óbvios
O código deve ser autoexplicativo. Comentários devem explicar o **porquê** de uma decisão complexa, não **o que** o código está fazendo.
- ❌ `// incrementa i em 1` sobre `i += 1`
- ✅ `// Usa polling em vez de WebSocket porque o firewall do cliente bloqueia conexões persistentes`

## Robustez e Testes

### Tratamento de erros explícito
Nunca ignore exceções ou falhas silenciosas. O código deve prever cenários de falha e tratar erros graciosamente.
- Capture exceções e tome uma ação: log, fallback, retry ou propagação com contexto.
- ❌ `try { ... } catch(e) {}`
- ✅ `try { ... } catch(e) { logger.error("Falha ao processar pedido", { pedidoId, erro: e.message }); throw e; }`

### Escreva testes automáticos
Código perfeito é código testado. Testes unitários e de integração garantem que alterações futuras não quebrem o funcionamento existente.
- Cubra os fluxos críticos com testes automatizados.
- Toda funcionalidade nova deve vir acompanhada de testes.

## Resumo: O que fazer e o que evitar

| ✅ Fazer                                    | ❌ Evitar                                           |
|---------------------------------------------|-----------------------------------------------------|
| Funções pequenas (10-20 linhas)             | Funções gigantescas que fazem múltiplos processos   |
| Nomes claros e autoexplicativos             | Siglas obscuras e nomes de uma única letra          |
| Modularização e baixo acoplamento           | Classes/módulos dependentes de dezenas de outros    |
| Testes unitários cobrindo fluxos críticos   | Entregar código sem validação automatizada          |
| Código simples e direto                     | Over-engineering e padrões desnecessários           |
