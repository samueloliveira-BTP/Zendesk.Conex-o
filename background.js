/**
 * Assistente de Diagnóstico Zendesk — service worker (v5.1, dados da Plataforma Amigo)
 *
 * Centraliza as chamadas de rede. Toda a leitura das respostas da Amigo é feita aqui (amigo-core.js),
 * fora da página do Zendesk: o Zendesk recebe só um objeto pequeno e pronto (não trava a interface).
 *
 * Rotas (campo "action" da mensagem):
 *  - consultarCliente   → diagnóstico da etiqueta (conexão, status Online/Offline, equipamento, splitter)
 *  - consultarOnu       → dados da ONU já coletados pelo AutoISP (status, último sinal RX, última queda)
 *  - nomeSplitter       → nome do splitter da conexão (prioridade baixa)
 *  - buscarSplitters    → pesquisa de splitters pelo nome
 *  - clientesSplitter   → clientes de um splitter
 *  - statusConexao      → "Status da Conexão" (RADIUS) de uma conexão (verificação em massa do splitter; prioridade baixa)
 *  - fabricanteMac      → fabricante pelo prefixo OUI (com cache e fila de 1 req/s)
 *  - abordagem          → confere a Abordagem da Amigo (Tecnologia, Slot/Porta OLT, ID ONU) com o AutoISP — só leitura, nunca grava
 *  - testarPortas / ativarRedeLocal / redeLocalAtivada → teste de portas do roteador (lista do NMAP da equipe)
 *  - abrirAbordagemPreenchida / preencherTarefa → abre a edição da Amigo já preenchida (o atendente é quem salva)
 *  - ipOlt              → IP da OLT (AutoISP pelo ID da OLT; reserva: Amigo, Ativos de Rede pelo nome do uPE)
 *  - printAutoIsp       → print da página da ONU no AutoISP (aba em segundo plano; ver "Print" abaixo)
 *  - printTarefa / printPronto / printErro → conversa com a aba do AutoISP
 */
'use strict';

importScripts('amigo-core.js');

const { criarClienteAmigo, criarClienteAutoIsp, ErroAmigo, compararAbordagem } = self.AmigoCore;
const amigo = criarClienteAmigo({ fetchFn: (url, opcoes) => fetch(url, opcoes) });
const autoisp = criarClienteAutoIsp({ fetchFn: (url, opcoes) => fetch(url, opcoes) });

const CACHE_MAC_MS = 30 * 24 * 3600 * 1000;
const esperar = ms => new Promise(r => setTimeout(r, ms));

// Fila da API de fabricantes (plano gratuito aceita ~1 requisição/s).
let filaMac = Promise.resolve();
function enfileirarMac(tarefa) {
    const resultado = filaMac.then(tarefa);
    filaMac = resultado.catch(() => {}).then(() => esperar(1100));
    return resultado;
}

// ==========================================
// Print da página da ONU no AutoISP
// ==========================================
//
// Abre a página da ONU numa aba em segundo plano (#zx-print=<token>). Lá o content.js espera o "Status GPON"
// (e a leitura nova da OLT, se vier), desenha a parte de cima da página numa imagem (html2canvas, sem
// depender da aba estar visível) e devolve a imagem. A aba fecha sozinha. Só leitura no AutoISP.

const TEMPO_PRINT_MS = 60000;
const LINK_ONU_AUTOISP = /^https:\/\/autoisp\.brasiltecpar\.com\.br\/contracted_services\/\d{1,12}$/;
const IMAGEM_PRINT = /^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/=]+$/;
const TAMANHO_MAX_PRINT = 12 * 1024 * 1024;
const prints = new Map(); // token → tarefa

function tirarPrintAutoIsp(link, janela) {
    return new Promise((resolve, reject) => {
        const token = crypto.randomUUID();
        const t = { token, tabId: null };
        const fechar = () => { if (t.tabId !== null) chrome.tabs.remove(t.tabId).catch(() => {}); };
        t.terminar = (erro, valor) => {
            if (!prints.has(token)) return;
            prints.delete(token);
            clearTimeout(t.timer);
            fechar();
            if (erro) reject(erro); else resolve(valor);
        };
        t.timer = setTimeout(() => t.terminar(new ErroAmigo('O AutoISP não terminou de carregar a página da ONU a tempo.', 'TIMEOUT')), TEMPO_PRINT_MS);
        prints.set(token, t);
        const opcoes = { url: `${link}#zx-print=${token}`, active: false };
        if (Number.isInteger(janela)) opcoes.windowId = janela;
        chrome.tabs.create(opcoes)
            .then(tab => { t.tabId = tab.id; if (!prints.has(token)) fechar(); })
            .catch(() => t.terminar(new ErroAmigo('Não foi possível abrir a página da ONU no AutoISP.', 'ABA')));
    });
}

// Aba do print fechada antes do fim: avisa em vez de esperar o tempo-limite.
chrome.tabs.onRemoved.addListener(tabId => {
    for (const t of prints.values()) {
        if (t.tabId === tabId) {
            t.tabId = null;
            t.terminar(new ErroAmigo('A aba do AutoISP foi fechada antes do print.', 'ABA'));
        }
    }
});

// ==========================================
// Teste de portas do roteador do cliente (versão "de navegador" do NMAP da equipe)
// ==========================================
//
// Lista do NMAP usado pela equipe (nmap -sT -sV -p 22,23,80,291,443,801,807,1079,1080-1090,2804,6080,8080,
// 8090,8291-8292,61200,49665,33777,9898,8083,8081,9001,8888,8991,8288,8088,8188,8082,61203,65493,44055,42220).
// Roda AQUI (service worker): a página do Zendesk é HTTPS e o Chrome bloqueia http://IP a partir dela
// ("Mixed Content", visto em 26/11/2026). O Chrome 158+ ainda exige a permissão "Acesso à rede local" para a
// extensão: ela é pedida UMA vez pela janela rede-local.html (o service worker não pode mostrar o aviso).
// Limites do navegador: 22/23 bloqueadas ("não testável"); porta aberta que não fala HTTP (Winbox 8291)
// parece fechada; HTTPS com certificado próprio = "inconclusiva"; sem -sV. Só o IPv4 do cliente do ticket.

const PORTAS_ROTEADOR = [
    80, 8080, 8081, 8082, 8083, 8088, 8090, 8188, 8288, 8888, 8991, 9001, 9898, 6080, 2804, 291, 801, 807,
    443, 1079, 1080, 1081, 1082, 1083, 1084, 1085, 1086, 1087, 1088, 1089, 1090, 8291, 8292,
    33777, 42220, 44055, 49665, 61200, 61203, 65493, 22, 23
];
const PORTAS_BLOQUEADAS_CHROME = new Set([22, 23]);
const PORTAS_HTTPS = new Set([443]);
const TEMPO_PORTA_MS = 3000;
const PARALELO_PORTAS = 8;
const IPV4_ROTEADOR = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const cachePortas = new Map(); // ip → {em, valor} (5 min)

/** Permissão "Acesso à rede local" da extensão: granted | prompt | denied | indisponivel (Chrome sem a proteção). */
async function permissaoRedeLocal() {
    try { return (await navigator.permissions.query({ name: 'local-network-access' })).state; } catch (e) { return 'indisponivel'; }
}

async function testarPorta(ip, porta) {
    if (PORTAS_BLOQUEADAS_CHROME.has(porta)) return { porta, estado: 'nao-testavel' };
    const esquema = PORTAS_HTTPS.has(porta) ? 'https' : 'http';
    const url = `${esquema}://${ip}:${porta}/`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TEMPO_PORTA_MS);
    const t0 = Date.now();
    try {
        // Resposta opaca: nada da página do roteador é lido, só se um servidor web respondeu.
        await fetch(url, { mode: 'no-cors', credentials: 'omit', cache: 'no-store', signal: ctrl.signal, targetAddressSpace: 'local' });
        return { porta, estado: 'aberta', url: porta === 80 ? `http://${ip}/` : url, ms: Date.now() - t0 };
    } catch (e) {
        if (ctrl.signal.aborted) return { porta, estado: 'sem-resposta', ms: Date.now() - t0 };
        const erro = String((e && e.message) || e || '').slice(0, 160);
        return { porta, estado: esquema === 'https' ? 'inconclusiva' : 'fechada', ms: Date.now() - t0, erro };
    } finally {
        clearTimeout(timer);
    }
}

async function testarPortasRoteador(ip) {
    const fila = [...PORTAS_ROTEADOR];
    const portas = [];
    await Promise.all(Array.from({ length: PARALELO_PORTAS }, async () => {
        while (fila.length) portas.push(await testarPorta(ip, fila.shift()));
    }));
    const ordem = new Map(PORTAS_ROTEADOR.map((p, i) => [p, i]));
    return portas.sort((a, b) => ordem.get(a.porta) - ordem.get(b.porta));
}

// ==========================================
// Atualizações
// ==========================================
//
// Desde a v6.11.0 a extensão é distribuída pela Chrome Web Store (visibilidade particular, só contas
// @brasiltecpar.com.br): o próprio Chrome atualiza. O antigo aviso de versão nova pelo GitHub foi removido;
// ao instalar/atualizar, apagamos o que ele deixou (badge "NEW" e storage). O alarme antigo não dispara mais
// nada (a permissão "alarms" saiu do manifest).
async function limparAvisoAntigoDeVersao() {
    await chrome.storage.local.remove('atualizacao').catch(() => {});
    await chrome.action.setBadgeText({ text: '' }).catch(() => {});
    await chrome.action.setTitle({ title: 'Assistente de Diagnóstico Zendesk' }).catch(() => {});
}

// Abordagem: páginas de edição da Amigo abertas para o atendente completar (token → {idConexao, preencher, tabId}).
const VALIDADE_PREENCHIMENTO_MS = 2 * 60 * 1000;
const preenchimentos = new Map();

/** Tarefa de print do token, só para a aba que a extensão abriu. */
function printDaAba(token, sender) {
    const t = typeof token === 'string' ? prints.get(token) : null;
    if (!t || !sender.tab || sender.tab.id !== t.tabId) throw new ErroAmigo('Tarefa desconhecida.', 'ENTRADA');
    return t;
}

const handlers = {
    async consultarCliente({ etiqueta, forcar }) {
        return { data: await amigo.consultarCliente(etiqueta, { forcar: forcar === true }) };
    },

    /** IP da OLT: AutoISP pelo ID (rápido); se não houver, Amigo pelo nome do Ponto de acesso (uPE). */
    async ipOlt({ oltId, pontoAcesso, olt }) {
        let erro = null;
        if (oltId) {
            try {
                const r = await autoisp.ipOlt(oltId);
                if (r) return { data: { ip: r.ip, nome: r.hostname, fonte: 'AutoISP' } };
            } catch (e) { erro = e; }
        }
        const nomes = [...new Set([pontoAcesso, olt].map(n => String(n || '').trim()).filter(Boolean))];
        for (const nome of nomes) {
            try {
                const r = await amigo.ipDoUpe(nome);
                if (r) return { data: { ip: r.ip, nome, fonte: 'Amigo' } };
            } catch (e) { erro = erro || e; }
        }
        if (erro) throw erro;
        return { data: null };
    },

    async printAutoIsp({ link }, sender) {
        if (typeof link !== 'string' || !LINK_ONU_AUTOISP.test(link)) throw new ErroAmigo('Página da ONU inválida.', 'ENTRADA');
        const dataUrl = await tirarPrintAutoIsp(link, sender.tab && sender.tab.windowId);
        return { dataUrl };
    },

    async printTarefa({ token }, sender) {
        printDaAba(token, sender);
        return {};
    },

    async printPronto({ token, dataUrl }, sender) {
        const t = printDaAba(token, sender);
        if (typeof dataUrl !== 'string' || dataUrl.length > TAMANHO_MAX_PRINT || !IMAGEM_PRINT.test(dataUrl)) {
            t.terminar(new ErroAmigo('O print gerado é inválido ou grande demais.', 'FORMATO'));
        } else {
            t.terminar(null, dataUrl);
        }
        return {};
    },

    async printErro({ token, mensagem }, sender) {
        const t = printDaAba(token, sender);
        t.terminar(new ErroAmigo(String(mensagem || 'Falha ao gerar o print.').slice(0, 200), 'PAGINA'));
        return {};
    },

    async consultarOnu({ etiqueta, usuario, forcar, aoVivo }) {
        // aoVivo: pede leitura nova na OLT (como ao abrir a página do AutoISP) — ~15 s.
        return { data: await autoisp.consultarOnu(etiqueta, usuario, { forcar: forcar === true, aoVivo: aoVivo === true }) };
    },

    async nomeSplitter({ idConexao, ctoId }) {
        return { nome: await amigo.nomeSplitter(idConexao, ctoId) };
    },

    async buscarSplitters({ termo, pagina }) {
        return { data: await amigo.buscarSplitters(termo, pagina) };
    },

    async clientesSplitter({ ctoId }) {
        return { data: await amigo.clientesDoSplitter(ctoId) };
    },

    async statusConexao({ idConexao, usuarioPppoe }) {
        // Verificação em massa: prioridade baixa (o ticket aberto passa na frente).
        const r = await amigo.statusConexao({ idConexao, usuario: usuarioPppoe }, { prioridade: 'baixa' });
        return { data: { estado: r.estado, motivo: r.motivo } };
    },

    async fabricanteMac({ mac }) {
        const hex = String(mac || '').toUpperCase().replace(/[^0-9A-F]/g, '');
        if (hex.length !== 12) return { fabricante: 'Desconhecido' };
        // Envia só o prefixo do fabricante (OUI), nunca o MAC completo do cliente.
        const oui = hex.slice(0, 6);
        const chave = 'oui_' + oui;
        const salvo = (await chrome.storage.local.get(chave))[chave];
        if (salvo && Date.now() - salvo.at < CACHE_MAC_MS) return { fabricante: salvo.v };

        const fabricante = await enfileirarMac(async () => {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 10000);
            try {
                const resp = await fetch('https://api.macvendors.com/' + encodeURIComponent(oui.match(/../g).join(':')), { signal: ctrl.signal });
                if (resp.status === 404) return 'Desconhecido';
                if (!resp.ok) throw new ErroAmigo('Consulta de fabricante indisponível.');
                return (await resp.text()).trim().slice(0, 100) || 'Desconhecido';
            } finally {
                clearTimeout(timer);
            }
        });
        await chrome.storage.local.set({ [chave]: { v: fabricante, at: Date.now() } });
        return { fabricante };
    },

    /**
     * Conferência da Abordagem para o painel (dados em cache; a página /edit em prioridade baixa).
     * forcar: relê a página /edit (o atendente voltou da Amigo, talvez tenha salvado).
     */
    async abordagem({ etiqueta, usuario, forcar }) {
        const cli = await amigo.consultarCliente(etiqueta);
        const onu = await autoisp.consultarOnu(etiqueta, usuario).catch(e => {
            if (e.codigo === 'NAO_ENCONTRADO') return null; // sem ONU no AutoISP: itens "sem dado"
            throw e;
        });
        const ab = await amigo.abordagem(cli.conexao.id, forcar === true ? { prioridade: 'alta', forcar: true } : undefined);
        return { data: { idConexao: cli.conexao.id, ...compararAbordagem(ab, cli.conexao, onu) } };
    },

    /**
     * Abre a página de edição da conexão na Amigo, à vista do atendente, e deixa a aba preencher os campos
     * vazios da Abordagem com os dados do AutoISP. QUEM SALVA É O ATENDENTE: a extensão nunca clica em Salvar.
     * Os valores ficam aqui (token de uso único), não na URL.
     */
    async abrirAbordagemPreenchida({ etiqueta, usuario, idConexao }, sender) {
        const cli = await amigo.consultarCliente(etiqueta, { forcar: true });
        if (cli.conexao.id !== String(idConexao)) throw new ErroAmigo('A conexão desta etiqueta mudou. Clique em Atualizar.', 'MUDOU');
        const onu = await autoisp.consultarOnu(etiqueta, usuario);
        const ab = await amigo.abordagem(cli.conexao.id, { prioridade: 'alta', forcar: true });
        const plano = compararAbordagem(ab, cli.conexao, onu);
        if (!plano.totalPreencher) throw new ErroAmigo('A Abordagem já está completa na Amigo. Clique em Atualizar.', 'MUDOU');
        const token = crypto.randomUUID();
        const p = { idConexao: cli.conexao.id, preencher: plano.preencher, tabId: null };
        preenchimentos.set(token, p);
        setTimeout(() => preenchimentos.delete(token), VALIDADE_PREENCHIMENTO_MS);
        // /view é a página completa (menu, estilos e o formulário de edição carregado nela). A /edit sozinha
        // é só o pedaço do formulário, sem CSS — abre "quebrada" (visto em 26/11/2026).
        const opcoes = { url: `${self.AmigoCore.AMIGO_ORIGEM}/pt/network-documentation/connection/${cli.conexao.id}/view#zx-preencher=${token}`, active: true };
        if (sender.tab) {
            opcoes.windowId = sender.tab.windowId;
            opcoes.index = sender.tab.index + 1;
            opcoes.openerTabId = sender.tab.id;
        }
        const tab = await chrome.tabs.create(opcoes).catch(() => null);
        if (!tab) { preenchimentos.delete(token); throw new ErroAmigo('Não foi possível abrir a página da Amigo.', 'ABA'); }
        p.tabId = tab.id;
        return { preencher: plano.preencher };
    },

    /**
     * Teste das portas do roteador do cliente. Testa SEMPRE: no service worker a consulta da permissão de rede
     * local pode continuar "prompt" mesmo com a permissão dada (visto em 26/11/2026), então ela só serve de
     * dica para o painel quando nenhuma porta responde. Cache de 5 min por IP.
     */
    async testarPortas({ ip, forcar }) {
        const v = String(ip || '').trim();
        if (!IPV4_ROTEADOR.test(v)) throw new ErroAmigo('IP inválido.', 'ENTRADA');
        const permissao = await permissaoRedeLocal();
        const salvo = cachePortas.get(v);
        if (forcar !== true && salvo && Date.now() - salvo.em < 5 * 60 * 1000) return { data: salvo.valor };
        const t0 = Date.now();
        const portas = await testarPortasRoteador(v);
        const valor = { ip: v, permissao, portas, duracaoMs: Date.now() - t0 };
        cachePortas.set(v, { em: Date.now(), valor });
        if (cachePortas.size > 100) cachePortas.delete(cachePortas.keys().next().value);
        return { data: valor };
    },

    /** Abre a janelinha rede-local.html, onde o Chrome pede UMA vez a permissão "Acesso à rede local". */
    async ativarRedeLocal({ ip }) {
        const v = String(ip || '').trim();
        if (!IPV4_ROTEADOR.test(v)) throw new ErroAmigo('IP inválido.', 'ENTRADA');
        await chrome.windows.create({
            url: chrome.runtime.getURL(`rede-local.html?ip=${encodeURIComponent(v)}`),
            type: 'popup', width: 520, height: 300, focused: true
        });
        return {};
    },

    /** Diagnóstico da janelinha: a porta 80 do IP, testada daqui (service worker), com o erro do Chrome. */
    async diagnosticoPorta80({ ip }) {
        const v = String(ip || '').trim();
        if (!IPV4_ROTEADOR.test(v)) throw new ErroAmigo('IP inválido.', 'ENTRADA');
        return { data: await testarPorta(v, 80) };
    },

    /** Aviso da janelinha de que a permissão foi dada (o painel reconfere sozinho). */
    async redeLocalAtivada() {
        cachePortas.clear();
        return {};
    },

    /** A aba da Amigo pede os valores (uma vez só, e só a aba que a extensão abriu). */
    async preencherTarefa({ token }, sender) {
        const p = typeof token === 'string' ? preenchimentos.get(token) : null;
        if (!p || !sender.tab || sender.tab.id !== p.tabId) throw new ErroAmigo('Link de preenchimento expirado. Use o botão no Zendesk de novo.', 'ENTRADA');
        preenchimentos.delete(token);
        return { idConexao: p.idConexao, preencher: p.preencher };
    }


};

// Versões anteriores guardavam configurações, preferências e dados do AutoISP/n8n no storage.
chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.local.remove(['config', 'painelRecolhido', 'secoesAbertas']).catch(() => {});
    chrome.storage.session.remove('acesso').catch(() => {});
    limparAvisoAntigoDeVersao();
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // Aceita apenas mensagens da própria extensão e ações conhecidas.
    if (sender.id !== chrome.runtime.id) return false;
    const acao = request && request.action;
    if (typeof acao !== 'string' || !Object.prototype.hasOwnProperty.call(handlers, acao)) return false;

    handlers[acao](request, sender)
        .then(resultado => sendResponse({ success: true, ...resultado }))
        .catch(e => sendResponse({
            success: false,
            // Só mensagens nossas chegam à tela; detalhes internos de erros inesperados ficam no service worker.
            error: e instanceof ErroAmigo ? e.message : 'Erro inesperado na extensão.',
            codigo: (e && e.codigo) || null
        }));
    return true; // resposta assíncrona
});
