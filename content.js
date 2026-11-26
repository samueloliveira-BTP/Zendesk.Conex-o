/**
 * Assistente de Diagnóstico Zendesk — content script (v5.1, dados da Plataforma Amigo)
 *
 * Roda em:
 *  - Zendesk (agente): painel no campo "Etiqueta do cliente" (abaixo);
 *  - Plataforma Amigo: botão "AutoISP ↗" nas linhas da tabela de conexões;
 *  - AutoISP (client_search): se a busca por PPPoE não achar nada, refaz pelo ERP ID.
 *  ONU: só dados JÁ coletados pelo AutoISP (status, último sinal RX, última queda) — rápido, sem leitura
 *  em tempo real na OLT; para a leitura ao vivo há o link "Abrir ONU no AutoISP".
 *
 * No Zendesk, o painel de cada ticket mostra:
 *  - "Status da Conexão" igual ao da Amigo (RADIUS: Online/Offline/Indeterminado) e o horário da sessão;
 *  - dados do cliente, do equipamento e do splitter (com verificação em massa dos clientes do splitter);
 *  - pesquisa de splitter por nome (lista os clientes e verifica quem está online).
 *
 * Desempenho (correção dos travamentos com vários tickets abertos):
 *  - O Zendesk mantém os tickets abertos no DOM, só ocultos (visibility:hidden). O painel só consulta,
 *    anima e trabalha no ticket VISÍVEL; os demais ficam parados até o atendente voltar a eles.
 *  - Nenhum HTML da Amigo chega aqui: o service worker interpreta tudo e devolve um objeto pequeno.
 *  - O campo é localizado pelo data-test-id (sem varrer todos os <label> da página a cada mudança),
 *    e a varredura é limitada a ~3 por segundo, sem ficar adiada indefinidamente.
 *
 * Segurança:
 *  - Nada vindo da Amigo é inserido com innerHTML: tudo é montado com createElement/textContent.
 *  - Shadow DOM fechado: o CSS do Zendesk não afeta o painel e o nosso não afeta o Zendesk.
 *  - Teclas digitadas no painel não "vazam" para os atalhos de teclado do Zendesk.
 */
'use strict';

const AMIGO_ORIGEM = 'https://plataforma.sejaamigo.com.br';
const AUTOISP_ORIGEM = 'https://autoisp.brasiltecpar.com.br';
const ZABBIX_ORIGEM = 'https://zbx7.brasiltecpar.com.br';
// Downloads de versões novas da extensão (releases públicas do repositório no GitHub).
const GITHUB_REPO_URL = 'https://github.com/samueloliveira-BTP/Zendesk.Conex-o/';
/** Busca do Zabbix por um IP (mesma URL da busca da barra lateral do Zabbix). */
const urlZabbixIp = ip => `${ZABBIX_ORIGEM}/zabbix.php?action=search&search=${encodeURIComponent(ip)}`;
// Busca do cliente no AutoISP pela etiqueta (usuário PPPoE), só conexões ativas.
const AUTOISP_BUSCA = AUTOISP_ORIGEM + '/client_search?conn_state=1&pppoe_username=';
// Campo "Etiqueta do cliente" (ID do campo de ticket no Zendesk). O rótulo é o plano B se o ID mudar.
const ID_CAMPO_ETIQUETA = '42732442326804';
const SELETOR_CAMPO = `[data-test-id="ticket-form-field-text-field-${ID_CAMPO_ETIQUETA}"]`;
const ROTULO_CAMPO = 'Etiqueta do cliente';
const ETIQUETA_VALIDA = /^[A-Za-z0-9._:@/-]{1,64}$/;
// Ao voltar para um ticket, refaz a consulta se a última tiver mais de 3 minutos (status muda).
const RECARREGAR_APOS_MS = 3 * 60 * 1000;
// Eventos que não devem sair do painel. O painel fica DENTRO do formulário do ticket: se o Zendesk "vê"
// teclas, cliques ou foco aqui, dispara atalhos de teclado ou marca o ticket como alterado (aviso
// "Sair do site? Alterações não salvas" — visto em 11/10/2026 após clicar no painel).
const EVENTOS_ISOLADOS = [
    'keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'paste', 'cut', 'copy',
    'click', 'dblclick', 'auxclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup',
    'touchstart', 'touchend', 'focusin', 'focusout', 'change', 'submit'
];

// ==========================================
// 1. UTILITÁRIOS
// ==========================================

class ErroExtensao extends Error {
    constructor(mensagem, codigo) {
        super(mensagem);
        this.codigo = codigo || null;
    }
}

/** Envia mensagem ao service worker; trata extensão recarregada e ausência de resposta. */
function enviarMensagem(msg) {
    return new Promise((resolve, reject) => {
        try {
            if (!chrome.runtime || !chrome.runtime.id) throw new Error('contexto invalidado');
            chrome.runtime.sendMessage(msg, resposta => {
                if (chrome.runtime.lastError) return reject(new ErroExtensao('Extensão indisponível. Recarregue a página.', 'EXTENSAO'));
                if (!resposta) return reject(new ErroExtensao('Sem resposta da extensão.', 'EXTENSAO'));
                if (resposta.success) resolve(resposta);
                else reject(new ErroExtensao(resposta.error || 'Erro desconhecido.', resposta.codigo));
            });
        } catch (e) {
            reject(new ErroExtensao('A extensão foi atualizada. Recarregue a página (F5).', 'EXTENSAO'));
        }
    });
}

const buscarFabricante = mac =>
    enviarMensagem({ action: 'fabricanteMac', mac }).then(r => r.fabricante).catch(() => 'Desconhecido');

/**
 * Cria um elemento DOM com segurança. Filhos string viram nós de texto (nunca HTML).
 * Props: style (cssText), class, on<evento> (listener) e demais atributos.
 */
function h(tag, props = {}, ...filhos) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'style') el.style.cssText = v;
        else if (k === 'class') el.className = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
    }
    for (const f of filhos.flat()) {
        if (f === null || f === undefined || f === false || f === '') continue;
        el.append(f instanceof Node ? f : String(f));
    }
    return el;
}

const vazio = v => v === null || v === undefined || v === '' || v === '-' || v === 'N/A';

/** Abre URL em nova aba somente se pertencer a uma origem conhecida (Amigo, AutoISP, Zabbix ou o repositório). */
function abrirUrl(url) {
    const permitido = [AMIGO_ORIGEM + '/', AUTOISP_ORIGEM + '/', ZABBIX_ORIGEM + '/', GITHUB_REPO_URL].some(o => String(url).startsWith(o));
    if (permitido) window.open(url, '_blank', 'noopener');
}

// IPv4 estrito (cada parte 0–255): só um IP de verdade vira link para o roteador.
const IPV4_VALIDO = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

/** Abre a interface web do roteador do cliente numa guia nova. Só aceita http(s)://IPv4[:porta]/. */
function abrirRoteador(url) {
    const m = /^(https?):\/\/([\d.]+)(?::(\d{1,5}))?\/$/.exec(String(url || ''));
    if (m && IPV4_VALIDO.test(m[2]) && (!m[3] || Number(m[3]) <= 65535)) window.open(url, '_blank', 'noopener');
}

const urlConexao = id => `${AMIGO_ORIGEM}/pt/network-documentation/connection/${encodeURIComponent(id)}/view`;

/** Número do ticket da URL (/agent/tickets/12345). */
const ticketDaUrl = () => (location.pathname.match(/\/agent\/tickets\/(\d+)/) || [])[1] || null;

/** Número do ticket ao qual o campo pertence (contêiner com data-test-id "ticket-<n>-..."). */
function ticketDoCampo(el) {
    for (let e = el; e && e !== document.body; e = e.parentElement) {
        const m = /^ticket-(\d+)-/.exec(e.getAttribute('data-test-id') || '');
        if (m) return m[1];
    }
    return null;
}

/**
 * Roda fn quando o navegador estiver ocioso (no máximo após `limite` ms). Na troca de ticket o Zendesk
 * redesenha muita coisa: o trabalho da extensão espera esse pico passar em vez de disputar a mesma hora.
 */
function quandoOcioso(fn, limite = 800) {
    if (typeof requestIdleCallback === 'function') return requestIdleCallback(() => fn(), { timeout: limite });
    return setTimeout(fn, 50);
}

/** Data/hora ISO do AutoISP em "14:32" (hoje) ou "04/10 14:32". */
function formatarDataIso(iso) {
    const t = Date.parse(iso || '');
    return Number.isNaN(t) ? '' : formatarHora(t);
}

/** "14:32" se for hoje; "04/10 14:32" se for de outro dia. */
function formatarHora(ms) {
    const d = new Date(ms);
    const hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === new Date().toDateString()) return hora;
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' + hora;
}

/** Detecta tema escuro pela cor de fundo do ancestral mais próximo que tenha fundo. */
function temaDe(baseElement) {
    for (let el = baseElement; el && el.nodeType === 1; el = el.parentElement) {
        const bg = getComputedStyle(el).backgroundColor;
        if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
            const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
            if (m) return ((+m[1] * 299 + +m[2] * 587 + +m[3] * 114) / 1000) < 128 ? 'escuro' : 'claro';
            break;
        }
    }
    return 'claro';
}

/** Copia o visual do campo vizinho do Zendesk (fonte, cores, borda, altura) para variáveis CSS. */
function estiloZendesk(input, label, tema) {
    const ci = getComputedStyle(input);
    const cl = label ? getComputedStyle(label) : ci;
    const transparente = c => !c || c === 'transparent' || /rgba\(.*,\s*0\)$/.test(c);
    // Ticket somente leitura: o campo fica desabilitado e com texto apagado; o painel usa a cor do rótulo.
    const bloqueado = input.disabled || input.readOnly;
    return {
        '--zd-fonte': ci.fontFamily,
        '--zd-tam': ci.fontSize,
        '--zd-texto': bloqueado ? cl.color : ci.color,
        '--zd-rotulo': cl.color,
        '--zd-rotulo-peso': cl.fontWeight,
        '--zd-rotulo-tam': cl.fontSize,
        '--zd-campo-bg': transparente(ci.backgroundColor) ? (tema === 'escuro' ? '#1f2326' : '#ffffff') : ci.backgroundColor,
        '--zd-borda': transparente(ci.borderTopColor) ? (tema === 'escuro' ? '#49545c' : '#d8dcde') : ci.borderTopColor,
        '--zd-raio': ci.borderTopLeftRadius,
        '--zd-altura': input.offsetHeight ? input.offsetHeight + 'px' : '32px'
    };
}

// ==========================================
// 2. ESTILOS E COMPONENTES
// ==========================================

const ESTILOS = `
/* clear: o campo do Zendesk usa float:left; sem isto o painel sobe por trás do campo e esconde o "Atualizar".
   contain: o que muda dentro do painel não obriga o Zendesk a recalcular/redesenhar a coluna inteira.
   visibility/pointer-events: inherit — o "all: initial" fazia o painel ficar VISÍVEL mesmo dentro de um ticket
   que o Zendesk escondeu (visibility:hidden). O painel do ticket oculto, invisível, ficava por cima da coluna do
   ticket atual e "roubava" a roda do mouse e os cliques (menu travado, só a barra de rolagem funcionava). */
:host { all: initial; display: block; clear: both; contain: layout paint style; visibility: inherit; pointer-events: inherit; }
.raiz {
  --fonte: var(--zd-fonte, -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif);
  --tam: var(--zd-tam, 14px); --texto: var(--zd-texto, #2f3941); --rotulo: var(--zd-rotulo, #2f3941);
  --rotulo-peso: var(--zd-rotulo-peso, 600); --rotulo-tam: var(--zd-rotulo-tam, 14px);
  --campo-bg: var(--zd-campo-bg, #ffffff); --borda: var(--zd-borda, #d8dcde);
  --raio: var(--zd-raio, 4px); --altura: var(--zd-altura, 32px);
  --suave: color-mix(in srgb, var(--texto) 62%, var(--campo-bg));
  --divisor: color-mix(in srgb, var(--borda) 65%, var(--campo-bg));
  --hover: color-mix(in srgb, var(--texto) 8%, transparent);
  --sk: color-mix(in srgb, var(--texto) 10%, var(--campo-bg));
  --link: #1f73b7; --ok: #038153; --erro: #cc3340; --aviso: #ad5918;
  --ok-bg: #edf8f4; --erro-bg: #fff0f1; --aviso-bg: #fff7ed;
  font-family: var(--fonte); font-size: var(--tam); line-height: 1.43; color: var(--texto);
  -webkit-font-smoothing: antialiased;
}
.raiz[data-tema="escuro"] {
  --link: #5eaee0; --ok: #26bd8a; --erro: #f5656f; --aviso: #f79a3e;
  --ok-bg: color-mix(in srgb, #26bd8a 16%, transparent);
  --erro-bg: color-mix(in srgb, #f5656f 16%, transparent);
  --aviso-bg: color-mix(in srgb, #f79a3e 16%, transparent);
}
*, *::before, *::after { box-sizing: border-box; }
button, input { font: inherit; }
[hidden] { display: none !important; }
svg { display: block; flex: none; }
.mono { font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; font-size: .93em; }

.barra { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: var(--altura); padding: 0 12px;
  border: 1px solid var(--borda); border-radius: var(--raio); background: transparent; color: var(--texto);
  font-size: var(--tam); font-weight: 600; line-height: 1; cursor: pointer; white-space: nowrap; transition: background-color .12s; }
.btn:hover { background: var(--hover); }
.btn:disabled { cursor: progress; opacity: .7; }
.btn-sm { height: 24px; padding: 0 8px; font-size: .857em; }
.barra-info { font-size: .857em; color: var(--suave); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.btn:focus-visible, .btn-icone:focus-visible, .link:focus-visible, .res-cab:focus-visible {
  outline: none; box-shadow: 0 0 0 3px color-mix(in srgb, var(--link) 35%, transparent); }

.cartao { margin-top: 8px; border: 1px solid var(--borda); border-radius: var(--raio); background: var(--campo-bg); overflow: hidden; }
.cab { display: flex; align-items: center; gap: 6px; padding: 8px 10px 2px; }
.titulo { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.resumo { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; font-size: .857em; font-weight: 600; white-space: nowrap; }
.sub { padding: 0 10px; font-size: .857em; color: var(--suave); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.links { display: flex; flex-wrap: wrap; gap: 4px 14px; padding: 4px 10px 8px; }
.links:empty { display: none; }
.link { display: inline-flex; align-items: center; gap: 4px; padding: 0; border: none; background: none; color: var(--link);
  font-size: .857em; cursor: pointer; border-radius: 2px; text-align: left; }
.link:hover { text-decoration: underline; }
.link:disabled { color: var(--suave); cursor: default; text-decoration: none; }
.avisos { display: grid; gap: 6px; padding: 0 10px 8px; }
.avisos:empty { display: none; }

.st { display: inline-flex; align-items: center; gap: 6px; }
.ponto { width: 8px; height: 8px; border-radius: 50%; background: currentColor; flex: none; }
.st-ok { color: var(--ok); } .st-erro { color: var(--erro); } .st-aviso { color: var(--aviso); }
.st-neutro, .st-carregando { color: var(--suave); }

.metricas { display: grid; gap: 6px; padding: 8px 10px; border-top: 1px solid var(--divisor); }
.metrica { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; min-width: 0; }
.metrica .rot { color: var(--rotulo); font-weight: var(--rotulo-peso); font-size: .857em; white-space: nowrap; }
.metrica .val { font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ip-acesso { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 4px 8px; margin-top: -2px; font-size: .857em; }
.ip-acesso .portas-ok { color: var(--ok); font-weight: 600; cursor: help; }
.ip-acesso .portas-nao { color: var(--suave); cursor: help; }
.ip-acesso:empty { display: none; }
.motivo { font-size: .857em; color: var(--suave); }

.secao { border-top: 1px solid var(--divisor); }
.secao-titulo { display: flex; align-items: center; gap: 6px; padding: 8px 10px 6px; text-transform: uppercase; letter-spacing: .04em;
  color: var(--suave); font-weight: 700; font-size: .75em; }
.fonte { margin-left: auto; font-weight: 400; color: var(--suave); font-size: .929em; text-transform: none; letter-spacing: 0; }
.secao-corpo { padding: 2px 10px 10px; }

.campos { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 12px; }
.campo { min-width: 0; }
.campo.largo { grid-column: 1 / -1; }
.campo .rotulo { color: var(--rotulo); font-weight: var(--rotulo-peso); font-size: .857em; line-height: 1.3; margin-bottom: 2px; }
.campo .valor { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 4px; min-width: 0; word-break: break-word; }
.detalhe { flex-basis: 100%; font-size: .857em; color: var(--suave); }
.vazio { color: var(--suave); }

.badge { display: inline-flex; align-items: center; gap: 4px; padding: 0 7px; border-radius: 999px; font-size: .786em; font-weight: 600; line-height: 1.7; white-space: nowrap; }
.badge-ok { background: var(--ok-bg); color: var(--ok); }
.badge-erro { background: var(--erro-bg); color: var(--erro); }
.badge-aviso { background: var(--aviso-bg); color: var(--aviso); }
.badge-neutro { background: var(--hover); color: var(--suave); }
.btn-icone { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; padding: 0;
  border: none; border-radius: 3px; background: transparent; color: var(--suave); cursor: pointer; }
.btn-icone:hover { background: var(--hover); color: var(--texto); }
.btn-icone.copiado { color: var(--ok); }
.alerta { display: flex; gap: 8px; align-items: flex-start; padding: 8px 10px; border-radius: var(--raio); font-size: .857em; background: var(--aviso-bg); }
.alerta > svg { color: var(--aviso); margin-top: 1px; }
.alerta-erro { background: var(--erro-bg); } .alerta-erro > svg { color: var(--erro); }
.alerta-info { background: var(--hover); } .alerta-info > svg { color: var(--link); }
.alerta-ok { background: var(--ok-bg); } .alerta-ok > svg { color: var(--ok); }
/* Abordagem (Amigo × AutoISP): uma linha de etiquetas, só para visualizar. */
.abord { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 6px 10px 8px; border-top: 1px solid var(--divisor); }
.abord:empty { display: none; }
.atualizacao { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 6px; padding: 6px 10px;
  border: 1px dashed var(--divisor); border-radius: 4px; font-size: .857em; color: var(--suave); }
.atualizacao:empty { display: none; }
.print-msg { margin-top: 8px; }
.print-msg:empty { display: none; }
.abord-rot { margin-right: 2px; text-transform: uppercase; letter-spacing: .04em; color: var(--suave); font-weight: 700; font-size: .75em; }
.abord .badge { cursor: help; }
/* Abordagem incompleta: faixa vermelha pulsando no topo do painel, impossível de não ver. */
.abord-urgente { display: flex; gap: 10px; align-items: flex-start; margin: 8px 10px 4px; padding: 10px 12px; border-radius: 6px;
  background: #d92d20; color: #fff; border: 2px solid #fff3; animation: zx-urgente 1.4s ease-out infinite; }
.abord-urgente:empty { display: none; animation: none; margin: 0; padding: 0; border: 0; }
.abord-urgente svg { flex: none; margin-top: 2px; }
.abord-urgente strong { display: block; font-size: 1.07em; letter-spacing: .03em; }
.abord-urgente .abord-falta { margin: 4px 0 8px; font-size: .93em; }
.abord-urgente .btn { background: #fff; color: #b42318; border-color: #fff; font-weight: 700; }
.abord-urgente .btn:hover { background: #ffe9e7; }
.abord-urgente .abord-nota { margin-top: 6px; font-size: .857em; opacity: .95; }
@keyframes zx-urgente { 0% { box-shadow: 0 0 0 0 rgba(217, 45, 32, .75); } 70% { box-shadow: 0 0 0 10px rgba(217, 45, 32, 0); } 100% { box-shadow: 0 0 0 0 rgba(217, 45, 32, 0); } }
@media (prefers-reduced-motion: reduce) { .abord-urgente { animation: none; } }
.alerta .acao { margin-top: 4px; }
.esqueleto { display: grid; gap: 8px; }
/* Esqueleto estático (sem animação): nada redesenhando a coluna enquanto o atendente rola. */
.sk { height: 9px; border-radius: 3px; background: var(--sk); }
.nota { display: flex; align-items: center; gap: 6px; font-size: .857em; color: var(--suave); }
.giro { width: 12px; height: 12px; border: 2px solid color-mix(in srgb, currentColor 25%, transparent); border-top-color: currentColor;
  border-radius: 50%; animation: girar .7s linear infinite; flex: none; }
@keyframes girar { to { transform: rotate(360deg); } }
/* Ticket em segundo plano: nada de animação gastando CPU. */
.raiz:not([data-ativo]) .giro { animation: none; }

/* Splitter e lista de clientes */
.cto-topo { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.cto-resultado { margin-top: 8px; display: grid; gap: 8px; }
/* minmax(0, 1fr): nome longo de cliente não estica a grade além do painel (cortava o status à direita). */
.cto-resultado, .resultados, .lista-wrap { grid-template-columns: minmax(0, 1fr); }
.lista-wrap { display: grid; gap: 6px; }
.cto-numeros, .cto-acoes { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.progresso { font-size: .857em; color: var(--suave); }
/* Sem rolagem interna: uma lista rolável dentro da coluna "prende" a roda do mouse e trava a rolagem do menu.
   Lista longa mostra os primeiros itens e um botão "Mostrar todos". */
.cto-lista { min-width: 0; border: 1px solid var(--divisor); border-radius: var(--raio); }
.cto-item { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 5px 8px; border-bottom: 1px solid var(--divisor); }
.cto-item:last-child { border-bottom: none; }
.cto-item .info { flex: 1 1 auto; min-width: 0; }
.cto-item .nome { display: block; width: 100%; max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--texto); font-size: 1em; }
.cto-item .tagc { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cto-item .tagc { font-size: .786em; color: var(--suave); }
.cto-item.atual { background: var(--hover); }
.cto-item.atual .nome { font-weight: 600; }
.cto-item .lado { display: flex; align-items: center; gap: 8px; flex: none; }

/* Pesquisa de splitter */
.busca { display: flex; gap: 6px; }
.entrada { flex: 1; min-width: 0; height: var(--altura); padding: 0 10px; border: 1px solid var(--borda); border-radius: var(--raio);
  background: var(--campo-bg); color: var(--texto); }
.entrada::placeholder { color: var(--suave); }
.entrada:focus { outline: none; border-color: var(--link); box-shadow: 0 0 0 3px color-mix(in srgb, var(--link) 35%, transparent); }
.resultados { margin-top: 8px; display: grid; gap: 6px; }
.resultados:empty { display: none; }
.res-item { border: 1px solid var(--divisor); border-radius: var(--raio); }
.res-cab { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; padding: 6px 8px;
  border: none; border-radius: var(--raio); background: none; color: var(--texto); cursor: pointer; text-align: left; }
.res-cab:hover { background: var(--hover); }
.res-cab .nome { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.res-cab[aria-expanded="true"] svg { transform: rotate(180deg); }
.res-corpo { padding: 0 8px 8px; }

@media (prefers-reduced-motion: reduce) { .giro { animation: none; } }
`;

/** Aplica a folha de estilos num shadow root (constructable stylesheet compartilhada; <style> como plano B). */
let folhaCompartilhada = null;
function aplicarEstilos(shadow) {
    try {
        if (!folhaCompartilhada) {
            folhaCompartilhada = new CSSStyleSheet();
            folhaCompartilhada.replaceSync(ESTILOS);
        }
        shadow.adoptedStyleSheets = [folhaCompartilhada];
    } catch (e) {
        shadow.append(h('style', {}, ESTILOS));
    }
}

// Ícones SVG simples (traço), desenhados aqui para não depender de recursos externos.
const ICONES = {
    externo: [['path', { d: 'M14 4h6v6' }], ['path', { d: 'M20 4l-9 9' }], ['path', { d: 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5' }]],
    atualizar: [['path', { d: 'M20 11a8 8 0 1 0-2.34 5.66' }], ['path', { d: 'M20 4v7h-7' }]],
    copiar: [['rect', { x: 9, y: 9, width: 11, height: 11, rx: 2 }], ['path', { d: 'M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1' }]],
    ok: [['path', { d: 'M20 6L9 17l-5-5' }]],
    olho: [['path', { d: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z' }], ['circle', { cx: 12, cy: 12, r: 3 }]],
    olhoFechado: [['path', { d: 'M3 3l18 18' }], ['path', { d: 'M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1' }],
        ['path', { d: 'M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6' }], ['path', { d: 'M9.9 9.9a3 3 0 0 0 4.2 4.2' }]],
    alerta: [['circle', { cx: 12, cy: 12, r: 10 }], ['path', { d: 'M12 8v4' }], ['path', { d: 'M12 16h.01' }]],
    chevron: [['path', { d: 'M6 9l6 6 6-6' }]],
    busca: [['circle', { cx: 11, cy: 11, r: 7 }], ['path', { d: 'M20 20l-3.5-3.5' }]],
    pulso: [['path', { d: 'M3 12h4l3-8 4 16 3-8h4' }]],
    camera: [['path', { d: 'M3 8a2 2 0 0 1 2-2h2l2-2h6l2 2h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }], ['circle', { cx: 12, cy: 13, r: 4 }]],
    usuarios: [['path', { d: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2' }], ['circle', { cx: 9, cy: 7, r: 4 }],
        ['path', { d: 'M23 21v-2a4 4 0 0 0-3-3.87' }], ['path', { d: 'M16 3.13a4 4 0 0 1 0 7.75' }]]
};

function icone(nome, tamanho = 16) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    const attrs = { viewBox: '0 0 24 24', width: tamanho, height: tamanho, fill: 'none', stroke: 'currentColor',
        'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' };
    for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
    for (const [tag, a] of ICONES[nome] || []) {
        const el = document.createElementNS(NS, tag);
        for (const [k, v] of Object.entries(a)) el.setAttribute(k, v);
        svg.append(el);
    }
    return svg;
}

function botao(texto, { ic = null, pequeno = false, titulo = null, onclick = null } = {}) {
    return h('button', { type: 'button', class: `btn${pequeno ? ' btn-sm' : ''}`, title: titulo, onclick },
        ic ? icone(ic, pequeno ? 12 : 14) : null, h('span', {}, texto));
}

/** Troca ícone e texto de um botão criado por botao(). */
function rotularBotao(btn, texto, ic = null, carregando = false) {
    const pequeno = btn.classList.contains('btn-sm');
    btn.replaceChildren(carregando ? h('span', { class: 'giro' }) : (ic ? icone(ic, pequeno ? 12 : 14) : ''), h('span', {}, texto));
}

/** Link de texto no estilo do Zendesk (abre em nova aba). */
function link(texto, { titulo = null, desabilitado = false, onclick = null } = {}) {
    return h('button', { type: 'button', class: 'link', title: titulo, disabled: desabilitado, onclick }, texto, icone('externo', 12));
}

function botaoIcone(ic, rotulo, onclick) {
    return h('button', { type: 'button', class: 'btn-icone', title: rotulo, 'aria-label': rotulo, onclick }, icone(ic, 13));
}

/** Botão de copiar com confirmação visual. */
function botaoCopiar(texto) {
    const btn = botaoIcone('copiar', 'Copiar', () => {
        navigator.clipboard.writeText(texto).then(() => {
            btn.classList.add('copiado');
            btn.replaceChildren(icone('ok', 13));
            btn.title = 'Copiado!';
            setTimeout(() => {
                btn.classList.remove('copiado');
                btn.replaceChildren(icone('copiar', 13));
                btn.title = 'Copiar';
            }, 1200);
        }).catch(() => { btn.title = 'Não foi possível copiar'; });
    });
    return btn;
}

const badge = (texto, tipo = 'neutro') => h('span', { class: `badge badge-${tipo}` }, texto);

function alerta(tipo, texto, acao = null) {
    return h('div', { class: `alerta alerta-${tipo}`, role: tipo === 'erro' ? 'alert' : 'status' },
        icone(tipo === 'ok' ? 'ok' : 'alerta', 14),
        h('div', {}, h('div', {}, texto), acao ? h('div', { class: 'acao' }, acao) : null));
}

/** Alerta para um erro da extensão/Amigo, com link de login quando a sessão da Amigo caiu. */
function alertaDeErro(e, tentarDeNovo = null) {
    if (e && e.codigo === 'LOGIN_REQUIRED') {
        return alerta('aviso', e.message, link('Abrir login da Amigo', { onclick: () => abrirUrl(AMIGO_ORIGEM + '/pt/login') }));
    }
    const tipo = e && ['NAO_ENCONTRADO', 'ENTRADA'].includes(e.codigo) ? 'aviso' : 'erro';
    const acao = tentarDeNovo && tipo === 'erro' ? botao('Tentar de novo', { ic: 'atualizar', pequeno: true, onclick: tentarDeNovo }) : null;
    return alerta(tipo, (e && e.message) || 'Erro inesperado.', acao);
}

const nota = texto => h('div', { class: 'nota' }, h('span', { class: 'giro' }), texto);

function esqueleto(linhas = 3) {
    const larguras = ['90%', '65%', '80%', '55%', '72%'];
    return h('div', { class: 'esqueleto', 'aria-hidden': 'true' },
        Array.from({ length: linhas }, (_, i) => h('div', { class: 'sk', style: `width:${larguras[i % larguras.length]}` })));
}

/** Um campo (rótulo em cima, valor embaixo). Valores vazios viram "—". */
function campo(rotulo, valor, { mono = false, copiar = false, detalhe = null, no = null, largo = false } = {}) {
    const el = h('div', { class: 'valor' });
    if (no) el.append(no);
    else if (vazio(valor)) el.append(h('span', { class: 'vazio' }, '—'));
    else {
        el.append(h('span', { class: mono ? 'mono' : '' }, String(valor)));
        if (copiar) el.append(botaoCopiar(String(valor)));
    }
    if (detalhe) el.append(detalhe instanceof Node ? detalhe : h('span', { class: 'detalhe' }, detalhe));
    return h('div', { class: `campo${largo ? ' largo' : ''}` }, h('div', { class: 'rotulo' }, rotulo), el);
}

const grade = (...campos) => h('div', { class: 'campos' }, campos.filter(Boolean));

function secao(titulo, fonte = 'Amigo') {
    const corpo = h('div', { class: 'secao-corpo' });
    const el = h('div', { class: 'secao' },
        h('div', { class: 'secao-titulo' }, h('span', {}, titulo), h('span', { class: 'fonte' }, fonte)),
        corpo);
    return { el, corpo };
}

/** Senha do equipamento: mascarada por padrão; revela por 15s. */
function campoSenha(senha) {
    if (!senha) return null;
    const MASCARA = '••••••••';
    const valor = h('span', { class: 'mono' }, MASCARA);
    let timer = null;
    const alternar = () => {
        const mostrar = valor.textContent === MASCARA;
        valor.textContent = mostrar ? senha : MASCARA;
        olho.replaceChildren(icone(mostrar ? 'olhoFechado' : 'olho', 13));
        olho.title = mostrar ? 'Ocultar senha' : 'Mostrar senha';
        clearTimeout(timer);
        if (mostrar) timer = setTimeout(alternar, 15000);
    };
    const olho = botaoIcone('olho', 'Mostrar senha', alternar);
    const frag = document.createDocumentFragment();
    frag.append(valor, olho, botaoCopiar(senha));
    return frag;
}

const ESTADOS = {
    online: { tipo: 'ok', texto: 'Online' },
    offline: { tipo: 'erro', texto: 'Offline' },
    indeterminado: { tipo: 'aviso', texto: 'Indeterminado' }
};

/** Indicador de status (bolinha + texto). */
function indicador(tipo, texto, dica = null) {
    return h('span', { class: `st st-${tipo}`, title: dica },
        tipo === 'carregando' ? h('span', { class: 'giro' }) : h('span', { class: 'ponto' }), texto);
}

/**
 * Modelos do texto de teste que o atendente cola no ticket, no padrão da equipe:
 *   --- TESTES CSA / ROTEADOR / ONU ---   (dados preenchidos automaticamente + checklist do atendimento)
 *   --- LOGÍSTICA / O.S. ---              (só quando o cliente está SEM ACESSO: texto para a logística abrir a O.S.)
 * Para mudar o padrão, edite só aqui.
 *  - titulo/analise: alerta exibido no painel;
 *  - verificado: 1ª linha do teste; checklist: o que o atendente confirma com o cliente;
 *  - logistica: linhas do bloco de O.S. (massivas: orienta NÃO abrir O.S. individual).
 */
const CHECKLIST_PADRAO = ['Energia confirmada', 'Equipamentos reiniciados sem sucesso', 'Cabos verificados'];
const MODELOS_DIAGNOSTICO = {
    los: {
        titulo: 'LOS – perda de sinal óptico',
        analise: 'A ONU está em LOS: não está chegando sinal óptico da rede até o equipamento do cliente.',
        verificado: 'Verificado ONU DOWN (LINK LOSS)',
        checklist: CHECKLIST_PADRAO,
        logistica: ['Cliente sem acesso, ONU DOWN com link loss.', 'Encaminhar técnico.']
    },
    dgi: {
        titulo: 'Sem energia (DGI – Dying Gasp)',
        analise: 'A ONU enviou Dying Gasp (DGI): o equipamento ficou sem energia elétrica.',
        verificado: 'Verificado ONU DOWN (DYING GASP – SEM ENERGIA)',
        checklist: ['Energia do local confirmada pelo cliente', 'Tomada, fonte e disjuntor verificados', 'Equipamentos reiniciados sem sucesso'],
        logistica: ['Cliente sem acesso, ONU DOWN por falta de energia (dying gasp) com energia do local confirmada.',
            'Encaminhar técnico para verificar/trocar a fonte da ONU.']
    },
    down: {
        titulo: 'ONU Down',
        analise: 'A ONU está fora (DOWN) sem causa identificada no AutoISP.',
        verificado: 'Verificado ONU DOWN',
        checklist: CHECKLIST_PADRAO,
        logistica: ['Cliente sem acesso, ONU DOWN.', 'Encaminhar técnico.']
    },
    indisponivel: {
        titulo: 'ONU não disponível',
        analise: 'O AutoISP não consegue obter o status da ONU (Não Disponível): ela pode estar desligada, sem comunicação com a OLT ou com problema de provisionamento.',
        verificado: 'Verificado ONU NÃO DISPONÍVEL na OLT',
        checklist: CHECKLIST_PADRAO,
        logistica: ['Cliente sem acesso, ONU sem comunicação com a OLT (não disponível).', 'Encaminhar técnico.']
    },
    'massiva-los': {
        titulo: 'Massiva LOS (rompimento na região)',
        analise: 'Há evento massivo de LOS na região do cliente (provável rompimento de fibra na rede).',
        verificado: 'Verificado ONU DOWN – MASSIVA LOS (rompimento na região)',
        checklist: [],
        logistica: ['Cliente sem acesso, afetado por massiva de LOS (rompimento na região) já em tratamento.',
            'NÃO abrir O.S. individual – aguardar a normalização da massiva.']
    },
    massiva: {
        titulo: 'Massiva de energia',
        analise: 'Há evento massivo de falta de energia na região do cliente.',
        verificado: 'Verificado ONU DOWN – MASSIVA DE ENERGIA na região',
        checklist: [],
        logistica: ['Cliente sem acesso, afetado por massiva de energia na região.',
            'NÃO abrir O.S. individual – aguardar a normalização da energia.']
    },
    // Sem problema na ONU, mas o cliente está sem acesso (PPPoE desconectado na Amigo).
    pppoe: {
        titulo: 'ONU UP sem autenticação PPPoE',
        analise: 'A ONU está UP, mas o cliente não está autenticado (sem sessão PPPoE).',
        verificado: 'Verificado ONU UP, sem autenticação PPPoE',
        checklist: ['Equipamentos reiniciados sem sucesso', 'Cabos entre ONU e roteador verificados', 'Configuração/credenciais do roteador verificadas'],
        logistica: ['Cliente sem acesso, ONU UP sem autenticação PPPoE (possível problema no roteador/configuração).', 'Encaminhar técnico.']
    },
    // Cliente sem acesso e sem dados da ONU no AutoISP.
    semacesso: {
        titulo: 'Cliente sem acesso',
        analise: 'Cliente sem acesso; o AutoISP não informou o estado da ONU.',
        verificado: 'Verificado cliente SEM ACESSO (estado da ONU não informado pelo AutoISP)',
        checklist: CHECKLIST_PADRAO,
        logistica: ['Cliente sem acesso.', 'Encaminhar técnico.']
    }
};

// Fabricante pelo prefixo do serial GPON (4 letras; em serial hexadecimal são os 8 primeiros dígitos).
const FABRICANTES_SERIAL = {
    HWTC: 'Huawei', ZTEG: 'ZTE', FHTT: 'Fiberhome', ALCL: 'Nokia', DGST: 'Digistar', ITBS: 'Intelbras',
    TPLG: 'TP-Link', PRKS: 'Parks', CDTC: 'C-Data', ZNTS: 'DZS/Zhone', VSOL: 'V-SOL', NOKG: 'Nokia', SKYW: 'Skyworth'
};
function fabricantePeloSerial(serial) {
    const s = String(serial || '').trim().toUpperCase();
    let codigo = '';
    if (/^[0-9A-F]{16}$/.test(s)) {
        const txt = s.slice(0, 8).match(/../g).map(x => String.fromCharCode(parseInt(x, 16))).join('');
        if (/^[A-Z]{4}$/.test(txt)) codigo = txt;
    } else if (/^[A-Z]{4}/.test(s)) codigo = s.slice(0, 4);
    if (!codigo) return '';
    return FABRICANTES_SERIAL[codigo] ? `${FABRICANTES_SERIAL[codigo]} (${codigo})` : codigo;
}

/** Qual modelo de texto usar: o problema da ONU ou, se o cliente está sem acesso, pppoe/semacesso. */
function tipoDoTeste(a, o) {
    const st = (o && o.statusOnu) || {};
    if (st.problema && MODELOS_DIAGNOSTICO[st.problema]) return st.problema;
    const semAcesso = a && a.estado === 'offline';
    if (!semAcesso) return null;
    return st.estado === 'online' ? 'pppoe' : 'semacesso';
}

/**
 * Monta o texto de teste para colar no ticket. `a` = dados da Amigo, `o` = dados da ONU (AutoISP),
 * `extra` = { splitter, caixa: {on, off, ind, total} | null }. tipo = chave de MODELOS_DIAGNOSTICO ou null
 * (cliente com acesso: só o bloco de testes, sem O.S.). Campos sem dado aparecem como "–", como no modelo.
 */
function montarTextoDiagnostico(tipo, a, o, extra = {}) {
    const m = tipo ? MODELOS_DIAGNOSTICO[tipo] : null;
    const c = (a && a.conexao) || {};
    const st = (o && o.statusOnu) || {};
    const s = o && o.sinal;
    const v = x => (x === null || x === undefined || x === '' ? '–' : x);
    const ip = (o && o.sessao && o.sessao.ip) || (a && a.ip) || '';

    const at = (o && o.statusAtual) || {};
    const desconectadoDesde = (a && a.estado === 'offline' && a.sessaoFim) || (st.problema && st.quando ? formatarDataIso(st.quando) : '');
    // Modelo: o da ONU no status atual do AutoISP; senão o da Amigo; senão o fabricante pelo serial.
    const modelo = at.modelo || (a && a.modelo) || (o && fabricantePeloSerial(o.serial)) || '';
    const link = o ? [o.olt, o.ponlink, o.onuId ? `ID ${o.onuId}` : ''].filter(Boolean).join(' ') : '';
    const quandoSinal = s ? (s.atual ? ' (atual)' : s.quando ? ` em ${formatarDataIso(s.quando)}` : '') : '';
    const sinal = s ? `${s.texto}${s.classificacao ? ` (${s.classificacao.rotulo})` : ''}${quandoSinal}` : '';
    // Local: descrição na OLT ("CE-…"); a Fiberhome grava "PON[5]-AN5506-01-A1[3]" (não é local) → usa a CTO.
    const desc = (o && o.descricaoOlt) || '';
    const local = desc && !/^PON\[/i.test(desc) ? desc : ((o && o.cto) || extra.splitter || desc);

    // "Demais clientes da caixa": resultado do "Verificar conexões" do splitter (sem contar o próprio cliente).
    let caixa = 'Demais clientes da caixa: não verificado';
    const cx = extra.caixa;
    if (cx && cx.on + cx.off > 0) {
        if (cx.off === 0) caixa = `Demais clientes da caixa estão UP (${cx.on} de ${cx.on + cx.off} online)`;
        else if (cx.off >= 3 && cx.off / (cx.on + cx.off) >= 0.5) caixa = `Demais clientes da caixa: ${cx.off} de ${cx.on + cx.off} OFFLINE – possível massiva`;
        else caixa = `Demais clientes da caixa: ${cx.on} online, ${cx.off} offline`;
    } else if (cx && cx.total === 0) caixa = 'Cliente único na caixa';

    const status = a && a.estado
        ? `Status da conexão (Amigo): ${(ESTADOS[a.estado] || {}).texto || a.estado}${a.estado === 'online' && a.sessaoInicio ? ` – sessão desde ${a.sessaoInicio}` : ''}`
        : '';

    const linhas = [
        '--- TESTES CSA / ROTEADOR / ONU ---',
        m ? m.verificado : (st.estado === 'online' ? 'Verificado ONU UP, cliente com acesso' : 'Verificado cliente com acesso'),
        c.nome || c.etiqueta ? `Cliente: ${v(c.nome)} | Etiqueta: ${v(c.etiqueta)}` : '',
        `Local: ${v(local)}`,
        `Link: ${v(link)}`,
        `Service Port: ${v(o && o.servicePort)}`,
        `VLAN: ${v(o && o.vlan)}`,
        `Modelo da ONU: ${v(modelo)}`,
        extra.splitter ? `Splitter: ${extra.splitter}` : '',
        status,
        `Plano desconectado desde: ${v(desconectadoDesde)}`,
        `Último sinal ONU: ${v(sinal)}`,
        at.rxOlt ? `Sinal OLT: ${at.rxOlt}` : '',
        at.ultimoOff ? `${at.estado === 'online' ? 'Última mudança de estado da ONU' : 'Último desligamento da ONU'}: ${formatarDataIso(at.ultimoOff)}${at.causaOff ? ` (${at.causaOff})` : ''}` : '',
        o && o.eventos && o.eventos.length > 1 ? `Últimos eventos: ${o.eventos.map(e => `${formatarDataIso(e.quando)} ${e.texto}`).join('; ')}` : '',
        ip ? `IP: ${ip}` : '',
        o && !o.olt && !o.ponlink && !o.serial ? 'ONU sem vínculo no AutoISP (sem OLT/PON cadastrados)' : '',
        caixa,
        ...(m ? m.checklist : []),
        ...(m ? ['', '--- LOGÍSTICA / O.S. ---', ...m.logistica] : [])
    ];
    // Linhas vazias só servem para separar os blocos.
    return linhas.filter((l, i) => l || (i > 0 && linhas[i + 1] === '--- LOGÍSTICA / O.S. ---')).join('\n');
}

/** Botão que copia um texto e confirma na própria etiqueta ("Copiado!"). */
function botaoCopiarTexto(rotulo, gerarTexto, { ic = 'copiar', pequeno = true } = {}) {
    const btn = botao(rotulo, { ic, pequeno, titulo: 'Copia o texto para colar no ticket' });
    btn.addEventListener('click', () => {
        navigator.clipboard.writeText(gerarTexto()).then(() => {
            rotularBotao(btn, 'Copiado!', 'ok');
            setTimeout(() => rotularBotao(btn, rotulo, ic), 1500);
        }).catch(() => rotularBotao(btn, 'Não foi possível copiar', ic));
    });
    return btn;
}

function tipoContrato(contrato, ativo) {
    if (ativo === false || /bloq|cancel|suspen|inativ/i.test(contrato || '')) return 'erro';
    if (/^normal$/i.test(contrato || '')) return 'ok';
    return 'neutro';
}

// ==========================================
// 3. SPLITTER: CLIENTES E VERIFICAÇÃO EM MASSA
// ==========================================

const ITENS_VISIVEIS = 12;

/**
 * Lista sem rolagem própria (rolagem interna "prende" a roda do mouse e trava o menu do Zendesk):
 * mostra os primeiros itens e um botão para exibir o resto.
 */
function listaCompacta(linhas) {
    const lista = h('div', { class: 'cto-lista' }, linhas.slice(0, ITENS_VISIVEIS));
    if (linhas.length <= ITENS_VISIVEIS) return lista;
    const mais = botao(`Mostrar todos (${linhas.length})`, { pequeno: true });
    mais.addEventListener('click', () => {
        lista.append(...linhas.slice(ITENS_VISIVEIS));
        mais.remove();
    });
    return h('div', { class: 'lista-wrap' }, lista, h('div', {}, mais));
}

/**
 * Bloco de um splitter: botão "Ver clientes" → lista com a situação do contrato de cada cliente e
 * botão "Verificar conexões", que consulta um a um quem está Online/Offline (com prioridade baixa,
 * para não atrasar o ticket aberto) e alerta possível problema massivo.
 * aoCancelar(fn) registra o que fazer quando o ticket sai de vista; devolve a função que desfaz o registro.
 */
function criarSplitter({ ctoId, nome, detalhe = null, etiquetaAtual = '', aoCancelar, mostrarNome = true, abrir = false, aoVerificar = null }) {
    const elNome = h('div', { class: 'mono', style: 'font-weight:600;word-break:break-word' }, nome || `Splitter #${ctoId}`);
    const resultado = h('div', { class: 'cto-resultado', hidden: true });
    const btn = botao('Ver clientes', { ic: 'usuarios', pequeno: true });
    let dados = null, carregando = false;
    let iniciarVerificacao = null; // definido quando a lista é desenhada

    async function alternar() {
        if (!resultado.hidden) {
            resultado.hidden = true;
            rotularBotao(btn, 'Ver clientes', 'usuarios');
            return;
        }
        resultado.hidden = false;
        rotularBotao(btn, 'Ocultar', 'usuarios');
        if (dados || carregando) return;
        carregando = true;
        resultado.replaceChildren(nota('Buscando clientes do splitter…'));
        try {
            dados = (await enviarMensagem({ action: 'clientesSplitter', ctoId })).data;
            renderLista();
        } catch (e) {
            resultado.replaceChildren(alertaDeErro(e)); // dados continua null: abrir de novo tenta outra vez
        } finally {
            carregando = false;
        }
    }
    btn.addEventListener('click', alternar);

    function renderLista() {
        const itens = dados.itens;
        if (!itens.length) {
            resultado.replaceChildren(alerta('info', 'Nenhum cliente encontrado neste splitter.'));
            return;
        }
        const alvoEtq = etiquetaAtual.toLowerCase();
        const ehAtual = c => !!alvoEtq && c.etiqueta.toLowerCase() === alvoEtq;
        const linhas = itens.map(c => {
            const status = h('span', { class: 'st st-neutro', title: 'Conexão não verificada' }, h('span', { class: 'ponto', style: 'opacity:.35' }));
            const atual = alvoEtq && c.etiqueta.toLowerCase() === alvoEtq;
            const row = h('div', { class: `cto-item${atual ? ' atual' : ''}` },
                h('div', { class: 'info' },
                    h('button', { type: 'button', class: 'link nome', title: `${c.nome || '-'} — abrir na Amigo`, onclick: () => abrirUrl(urlConexao(c.id)) }, c.nome || '-'),
                    h('div', { class: 'tagc mono' }, c.etiqueta || '-', c.porta ? `  ·  porta ${c.porta}` : '')),
                h('div', { class: 'lado' }, badge(c.contrato || '—', tipoContrato(c.contrato, c.ativo)), status));
            return { c, row, status };
        });
        const normais = itens.filter(c => tipoContrato(c.contrato, c.ativo) === 'ok').length;
        const bloqueados = itens.filter(c => tipoContrato(c.contrato, c.ativo) === 'erro').length;
        const semSituacao = itens.length - normais - bloqueados;
        const resumo = h('div', {});
        const progresso = h('span', { class: 'progresso' });
        const btnVerificar = botao('Verificar conexões', { ic: 'pulso', pequeno: true, titulo: 'Consulta na Amigo quem está online agora (um cliente por vez)' });
        let rodando = null;

        btnVerificar.addEventListener('click', async () => {
            if (rodando) { rodando.cancelado = true; return; } // o botão vira "Parar"
            const token = { cancelado: false };
            rodando = token;
            const desfazer = aoCancelar ? aoCancelar(() => { token.cancelado = true; }) : () => {};
            rotularBotao(btnVerificar, 'Parar', 'pulso');
            resumo.replaceChildren();
            // Contratos bloqueados/cancelados não são consultados (não têm sessão para medir).
            const alvos = linhas.filter(l => tipoContrato(l.c.contrato, l.c.ativo) !== 'erro');
            let on = 0, off = 0, ind = 0, feitos = 0;
            // "Demais clientes da caixa" (texto de teste): mesma contagem, sem o próprio cliente do ticket.
            const demais = { on: 0, off: 0, ind: 0, total: alvos.filter(l => !ehAtual(l.c)).length };
            for (const l of alvos) {
                if (token.cancelado) break;
                progresso.textContent = `Verificando ${feitos + 1} de ${alvos.length}…`;
                l.status.className = 'st st-carregando';
                l.status.replaceChildren(h('span', { class: 'giro' }));
                try {
                    const r = (await enviarMensagem({ action: 'statusConexao', idConexao: l.c.id, usuarioPppoe: l.c.usuarioPppoe || l.c.usuarioIpoe })).data;
                    const est = ESTADOS[r.estado] || ESTADOS.indeterminado;
                    l.status.className = `st st-${est.tipo}`;
                    l.status.title = `${est.texto}: ${r.motivo}`;
                    l.status.replaceChildren(h('span', { class: 'ponto' }));
                    if (r.estado === 'online') on++; else if (r.estado === 'offline') off++; else ind++;
                    if (!ehAtual(l.c)) {
                        if (r.estado === 'online') demais.on++; else if (r.estado === 'offline') demais.off++; else demais.ind++;
                    }
                } catch (e) {
                    l.status.className = 'st st-aviso';
                    l.status.title = e.message;
                    l.status.replaceChildren(h('span', { class: 'ponto' }));
                    ind++;
                    if (!ehAtual(l.c)) demais.ind++;
                    if (e.codigo === 'LOGIN_REQUIRED' || e.codigo === 'EXTENSAO') { resumo.replaceChildren(alertaDeErro(e)); break; }
                }
                feitos++;
            }
            const parcial = feitos < alvos.length ? ` (interrompido em ${feitos} de ${alvos.length})` : '';
            progresso.textContent = `${on} online · ${off} offline${ind ? ` · ${ind} sem leitura` : ''}${parcial}`;
            if (off >= 3 && off / Math.max(1, on + off) >= 0.5) {
                resumo.replaceChildren(alerta('aviso', `${off} de ${on + off} clientes verificados estão offline. Possível problema massivo neste splitter.`));
            }
            rodando = null;
            desfazer();
            rotularBotao(btnVerificar, 'Verificar de novo', 'pulso');
            if (aoVerificar && feitos === alvos.length) aoVerificar(demais);
        });
        iniciarVerificacao = () => { if (!rodando) btnVerificar.click(); };

        resultado.replaceChildren(
            resumo,
            h('div', { class: 'cto-numeros' },
                badge(`${normais} normal${normais === 1 ? '' : 'is'}`, 'ok'),
                bloqueados ? badge(`${bloqueados} bloqueado${bloqueados === 1 ? '' : 's'}`, 'erro') : null,
                semSituacao ? badge(`${semSituacao} sem situação`, 'neutro') : null,
                dados.total > itens.length ? h('span', { class: 'progresso' }, `primeiros ${itens.length} de ${dados.total}`) : null),
            h('div', { class: 'cto-acoes' }, btnVerificar, progresso),
            listaCompacta(linhas.map(l => l.row)));
    }

    const topo = h('div', { class: 'cto-topo' },
        mostrarNome ? h('div', { style: 'min-width:0' }, elNome, detalhe ? h('div', { class: 'detalhe' }, detalhe) : null) : h('span', {}),
        btn);
    if (abrir) alternar();
    /** Abre a lista (se preciso) e verifica as conexões da caixa. */
    async function verificarCaixa() {
        if (resultado.hidden) await alternar();
        else if (!dados && !carregando) await alternar();
        if (iniciarVerificacao) iniciarVerificacao();
    }
    return { el: h('div', {}, topo, resultado), definirNome: n => { elNome.textContent = n; }, verificarCaixa };
}

/** Pesquisa de splitter pelo nome (mesma busca do filtro "Splitter" da Amigo). */
function criarBuscaSplitter({ aoCancelar, etiquetaAtual }) {
    const entrada = h('input', {
        type: 'search', class: 'entrada', placeholder: 'Nome do splitter (ex.: CTO-123)', maxlength: '60',
        'aria-label': 'Nome do splitter', autocomplete: 'off', spellcheck: 'false'
    });
    const btn = botao('Buscar', { ic: 'busca' });
    const res = h('div', { class: 'resultados', 'aria-live': 'polite' });
    let seq = 0;

    function itemResultado(s) {
        const corpo = h('div', { class: 'res-corpo', hidden: true });
        let comp = null;
        const cab = h('button', { type: 'button', class: 'res-cab', 'aria-expanded': 'false', title: s.nome },
            h('span', { class: 'mono nome' }, s.nome), icone('chevron', 14));
        cab.addEventListener('click', () => {
            if (!comp) {
                comp = criarSplitter({ ctoId: s.id, nome: s.nome, etiquetaAtual: etiquetaAtual(), aoCancelar, mostrarNome: false, abrir: true });
                corpo.append(comp.el);
            }
            corpo.hidden = !corpo.hidden;
            cab.setAttribute('aria-expanded', String(!corpo.hidden));
        });
        return h('div', { class: 'res-item' }, cab, corpo);
    }

    async function buscar(pagina = 1, gatilho = null) {
        const termo = entrada.value.trim();
        if (termo.length < 2) {
            res.replaceChildren(alerta('info', 'Digite pelo menos 2 caracteres do nome do splitter.'));
            return;
        }
        const minha = ++seq;
        btn.disabled = true;
        const aguarde = nota('Buscando na Amigo… pode levar até 20 s.');
        if (gatilho) gatilho.replaceWith(aguarde);
        else res.replaceChildren(aguarde);
        try {
            const d = (await enviarMensagem({ action: 'buscarSplitters', termo, pagina })).data;
            if (minha !== seq) return;
            if (pagina === 1 && !d.itens.length) {
                res.replaceChildren(alerta('info', `Nenhum splitter encontrado para "${termo}".`));
                return;
            }
            aguarde.replaceWith(...d.itens.map(itemResultado));
            if (d.temMais) {
                const mais = botao('Carregar mais', { pequeno: true });
                mais.addEventListener('click', () => buscar(pagina + 1, mais));
                res.append(mais);
            }
        } catch (e) {
            if (minha === seq) aguarde.replaceWith(alertaDeErro(e));
        } finally {
            if (minha === seq) btn.disabled = false;
        }
    }

    entrada.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); buscar(1); }
    });
    btn.addEventListener('click', () => buscar(1));

    const s = secao('Buscar splitter');
    s.corpo.append(h('div', { class: 'busca' }, entrada, btn), res);
    return s.el;
}

/** Versão nova da extensão (uma consulta por carregamento da página; o service worker guarda o resultado). */
let promessaAtualizacao = null;
function atualizacaoDisponivel() {
    if (!promessaAtualizacao) {
        promessaAtualizacao = enviarMensagem({ action: 'statusAtualizacao' }).then(r => r.data).catch(() => null);
    }
    return promessaAtualizacao;
}

// ==========================================
// 4. PAINEL DE UM TICKET
// ==========================================

function criarPainelTicket(campoEl) {
    const input = campoEl.querySelector('input');
    if (!input) return null;
    const label = campoEl.querySelector('label');
    const ticketId = ticketDoCampo(campoEl);

    const host = h('div', { 'data-ext': 'diagnostico-amigo' });
    host.inert = true; // nasce inativo; definirAtivo(true) libera quando o ticket estiver à vista
    const shadow = host.attachShadow({ mode: 'closed' });
    aplicarEstilos(shadow);
    // Teclas e colagens dentro do painel não chegam aos atalhos/handlers do Zendesk.
    for (const tipo of EVENTOS_ISOLADOS) host.addEventListener(tipo, e => e.stopPropagation());

    const estado = {
        ativo: false, etiqueta: null, carregadoEm: 0, seq: 0, destruido: false, temResultado: false, etiquetaExibida: null,
        onuSeq: 0, onuNaoAchada: false, onuExibida: null, amigoFim: null,
        amigo: null, onu: null, splitterNome: '', // últimos dados exibidos (usados no texto copiado)
        caixa: null, verificarCaixa: null,         // resultado/ação do "Verificar conexões" do splitter do cliente
        elLeitura: null,                           // aviso "lendo na OLT" (botão "Ler agora na OLT")
        onuFinal: false, onuUsuario: null,         // consulta da ONU terminou (com ou sem ONU) e com qual usuário
        abordSeq: 0,     // conferência da Abordagem (Amigo × AutoISP)
        abordPendente: false, // abriu a Amigo preenchida e ainda falta salvar: reconfere ao voltar
        ipOlt: null,     // {chave, r}: IP da OLT já consultado (evita repetir a cada redesenho)
        salvandoPrint: false
    };
    // Mensagens do "Print na observação interna" (fica fora do redesenho da seção ONU).
    const elPrintMsg = h('div', { class: 'print-msg' });
    let elIp = null, elIpRotulo = null; // linha "IP" dos indicadores (preenchida com AutoISP ou Amigo)
    let elIpAcesso = null;              // linha logo abaixo do IP: "Acessar roteador"
    let elAbordagem = null;    // linha de etiquetas da Abordagem
    let elAbordUrgente = null; // faixa vermelha "Abordagem incompleta" (topo do painel)
    // Voltou da Amigo depois de abrir a edição preenchida: confere de novo (talvez já tenha salvado).
    let ultimaReconferencia = 0;
    window.addEventListener('focus', () => {
        // Voltou da janelinha "Ativar teste de portas": testa de novo o IP que aguardava a permissão.
        if (!estado.destruido && estado.portasAguardandoPermissao && elIpAcesso) {
            const ip = estado.portasAguardandoPermissao;
            estado.portasAguardandoPermissao = null;
            testarPortasRoteador(ip, false, true);
        }
    });
    window.addEventListener('focus', () => {
        if (estado.destruido || !estado.abordPendente || Date.now() - ultimaReconferencia < 4000) return;
        ultimaReconferencia = Date.now();
        carregarAbordagem(true);
    });
    const cancelaveis = new Set();
    const aoCancelar = fn => { cancelaveis.add(fn); return () => cancelaveis.delete(fn); };
    const cancelarTudo = () => { for (const fn of [...cancelaveis]) fn(); cancelaveis.clear(); };

    // Estrutura: [Atualizar | hora]  [cartão do diagnóstico]  [busca de splitter]
    const btnAtualizar = botao('Atualizar', { ic: 'atualizar', titulo: 'Consultar a Amigo de novo (ignora o cache)' });
    const info = h('span', { class: 'barra-info' });
    const elResumo = h('span', { class: 'resumo' });
    const elSub = h('div', { class: 'sub' });
    const elLinks = h('div', { class: 'links' });
    const elAvisos = h('div', { class: 'avisos' });
    const corpo = h('div', {});
    // ONU (AutoISP): seção própria, carregada em paralelo; não é substituída quando a Amigo responde.
    const sOnu = secao('ONU', 'AutoISP');
    sOnu.el.hidden = true;
    const cartao = h('div', { class: 'cartao' },
        h('div', { class: 'cab' }, h('span', { class: 'titulo' }, 'Conexão (Amigo)'), elResumo),
        elSub, elLinks, elAvisos, corpo, sOnu.el);
    const busca = criarBuscaSplitter({ aoCancelar, etiquetaAtual: () => estado.etiqueta || '' });
    // Aviso discreto de versão nova da extensão (verificada 1x/dia pelo service worker no GitHub).
    const elAtualizacao = h('div', { class: 'atualizacao' });
    atualizacaoDisponivel().then(a => {
        if (!a || estado.destruido) return;
        elAtualizacao.replaceChildren(
            h('span', {}, `Nova versão da extensão: ${a.versao} (você usa ${a.atual}).`),
            link('Baixar', { titulo: 'Abre o download da versão nova no GitHub', onclick: () => abrirUrl(a.url) }));
    });
    const raiz = h('div', { class: 'raiz' },
        h('div', { class: 'barra' }, btnAtualizar, info),
        cartao,
        h('div', { class: 'cartao' }, busca),
        elAtualizacao);
    shadow.append(raiz);
    campoEl.insertAdjacentElement('afterend', host);

    // Copiar o visual do Zendesk exige ler estilos/medidas (o navegador recalcula a página).
    // Por isso é feito na criação (que já roda em momento ocioso) e, depois, no máximo 1x por minuto,
    // sempre em momento ocioso — nunca no meio da troca de ticket.
    let visualEm = 0;
    const aplicarVisual = () => {
        if (estado.destruido || !campoEl.isConnected) return;
        visualEm = Date.now();
        const tema = temaDe(campoEl);
        raiz.dataset.tema = tema;
        for (const [k, v] of Object.entries(estiloZendesk(input, label, tema))) raiz.style.setProperty(k, v);
    };
    aplicarVisual();

    const definirCarregando = carregando => {
        btnAtualizar.disabled = carregando;
        btnAtualizar.setAttribute('aria-busy', String(carregando));
        rotularBotao(btnAtualizar, carregando ? 'Consultando…' : 'Atualizar', 'atualizar', carregando);
    };

    function limparCartao() {
        elSub.replaceChildren();
        elLinks.replaceChildren();
        elAvisos.replaceChildren();
    }

    function mostrarSemEtiqueta(texto, tipo = 'info') {
        estado.temResultado = false;
        estado.onuSeq++; // descarta respostas da ONU pendentes
        estado.onuExibida = null;
        estado.onu = null;
        estado.amigo = null;
        sOnu.el.hidden = true;
        limparCartao();
        elResumo.replaceChildren(indicador('neutro', 'Sem etiqueta'));
        corpo.replaceChildren(h('div', { class: 'secao-corpo', style: 'padding-top:8px' }, alerta(tipo, texto)));
    }

    function renderCarregando(etiqueta) {
        limparCartao();
        elResumo.replaceChildren(indicador('carregando', 'Verificando…'));
        elSub.textContent = `Etiqueta ${etiqueta}`;
        const s1 = secao('Cliente'), s2 = secao('Equipamento'), s3 = secao('Splitter');
        s1.corpo.append(esqueleto(4));
        s2.corpo.append(esqueleto(3));
        s3.corpo.append(esqueleto(1));
        corpo.replaceChildren(h('div', { class: 'metricas' }, esqueleto(3)), s1.el, s2.el, s3.el);
    }

    function renderErro(e) {
        estado.amigo = null;
        limparCartao();
        const naoAchou = e.codigo === 'NAO_ENCONTRADO';
        elResumo.replaceChildren(indicador('neutro', naoAchou ? 'Não localizado' : 'Indisponível', e.message));
        corpo.replaceChildren(h('div', { class: 'secao-corpo', style: 'padding-top:8px' }, alertaDeErro(e, () => consultar(true))));
    }

    function renderResultado(d) {
        estado.amigo = d;
        estado.caixa = null;
        estado.verificarCaixa = null;
        const c = d.conexao;
        const est = ESTADOS[d.estado] || ESTADOS.indeterminado;
        limparCartao();
        elResumo.replaceChildren(indicador(est.tipo, est.texto, d.motivo));
        elSub.textContent = [c.nome, c.plano].filter(Boolean).join(' · ');
        elSub.title = elSub.textContent;
        elLinks.append(
            // Texto de teste no padrão da equipe; sem acesso, já vem com o bloco LOGÍSTICA / O.S.
            botaoCopiarTexto('Copiar teste', textoDoTeste),
            link('Abrir na Amigo', { titulo: 'Abrir esta conexão na Amigo', onclick: () => abrirUrl(urlConexao(c.id)) }),
            link('Buscar no AutoISP', {
                titulo: 'Buscar esta etiqueta no AutoISP',
                onclick: () => abrirUrl(AUTOISP_BUSCA + encodeURIComponent(c.etiqueta || estado.etiqueta || ''))
            }));

        if (d.estado === 'indeterminado') {
            elAvisos.append(alerta('aviso', `${d.motivo} O status NÃO foi confirmado — não considere o cliente offline.`,
                botao('Tentar de novo', { ic: 'atualizar', pequeno: true, onclick: () => consultar(true) })));
        }
        if (d.massivas > 0) {
            const ids = d.massivasIds || [];
            const links = ids.length
                ? h('div', { class: 'links', style: 'padding:0' }, ids.map(id => link(`Ver massiva #${id}`, {
                    titulo: 'Abrir a massiva na Amigo',
                    onclick: () => abrirUrl(`${AMIGO_ORIGEM}/pt/network-documentation/service-massive/${encodeURIComponent(id)}/show`)
                })))
                : null;
            elAvisos.append(alerta('erro', `Há ${d.massivas} massiva(s) registrada(s) para este cliente na Amigo.` +
                ((d.massivasDescricao || []).length ? ` ${d.massivasDescricao.join(' · ')}` : ''), links));
        }
        if (d.correspondencias > 1) {
            elAvisos.append(alerta('info', `${d.correspondencias} conexões com esta etiqueta; mostrando a ativa mais recente.`));
        }
        if (d.filtro && d.filtro !== 'serviceTag') {
            elAvisos.append(alerta('info', `Localizado pelo ${d.filtro === 'userIpoe' ? 'usuário IPoE' : 'usuário PPPoE'}, não pela etiqueta.`));
        }

        // Indicadores principais + o motivo da decisão Online/Offline (transparência para o atendente).
        const linha = (rotulo, valor) => h('div', { class: 'metrica' },
            h('span', { class: 'rot' }, rotulo),
            h('span', { class: 'val' }, vazio(valor) ? h('span', { class: 'vazio' }, '—') : valor));
        const metricas = h('div', { class: 'metricas' },
            linha('Conexão', indicador(est.tipo, est.texto)),
            d.estado === 'offline' && d.sessaoFim
                ? linha('Desconectou em', d.sessaoFim)
                : linha('Sessão desde', d.sessaoInicio),
            // IP: do AutoISP quando disponível (mais confiável); atualizado quando a ONU responder.
            h('div', { class: 'metrica' }, elIpRotulo = h('span', { class: 'rot' }, 'IP atual'), elIp = h('span', { class: 'val' })),
            elIpAcesso = h('div', { class: 'ip-acesso' }),
            linha('Contrato', d.contrato ? badge(d.contrato, tipoContrato(d.contrato, c.ativo)) : ''),
            h('div', { class: 'motivo' }, d.motivo));

        const sCliente = secao('Cliente');
        sCliente.corpo.append(grade(
            campo('Nome', c.nome, { largo: true }),
            campo('Etiqueta', c.etiqueta, { mono: true, copiar: true }),
            campo('Tipo', c.tipo),
            campo('Plano', c.plano, { largo: true }),
            campo('Usuário PPPoE', c.usuarioPppoe || c.usuarioIpoe, { mono: true, copiar: true, largo: true }),
            campo('Status OLT', d.statusOlt),
            campo('Concentrador', c.concentrador, { mono: true, largo: true }),
            campo('Ponto de acesso (uPE)', c.pontoAcesso, { mono: true, largo: true })
        ));

        const sEquip = secao('Equipamento');
        const fabricante = h('span', { class: 'detalhe' }, d.mac ? 'Identificando fabricante…' : '');
        if (d.mac) buscarFabricante(d.mac).then(f => { fabricante.textContent = f === 'Desconhecido' ? 'Fabricante desconhecido' : f; });
        sEquip.corpo.append(grade(
            campo('Usuário equip.', d.usuarioEquip, { mono: true, copiar: true }),
            campo('Senha equip.', null, { no: campoSenha(d.senhaEquip) }),
            campo('MAC', d.mac, { mono: true, copiar: true, detalhe: d.mac ? fabricante : null, largo: true }),
            campo('Modelo', [d.tipoEquip, d.modelo].filter(Boolean).join(' ')),
            campo('Firmware', d.firmware, { mono: true }),
            campo('Limite', d.limite, { largo: true })
        ));

        const sSplitter = secao('Splitter');
        if (c.ctoId) {
            const posicao = [c.slot ? `Slot OLT ${c.slot}` : '', c.porta ? `Porta ${c.porta}` : ''].filter(Boolean).join(' · ');
            const comp = criarSplitter({
                ctoId: c.ctoId, nome: 'Carregando nome…', detalhe: posicao || 'Splitter / CTO do cliente', etiquetaAtual: c.etiqueta, aoCancelar,
                aoVerificar: r => { estado.caixa = r; } // vai para "Demais clientes da caixa" no texto de teste
            });
            estado.verificarCaixa = comp.verificarCaixa;
            sSplitter.corpo.append(comp.el);
            estado.splitterNome = '';
            enviarMensagem({ action: 'nomeSplitter', idConexao: c.id, ctoId: c.ctoId })
                .then(r => {
                    const nome = r.nome || `Splitter #${c.ctoId}`;
                    comp.definirNome(nome);
                    estado.splitterNome = [nome, posicao].filter(Boolean).join(' – '); // vai no texto copiado
                })
                .catch(() => comp.definirNome(`Splitter #${c.ctoId}`));
        } else {
            sSplitter.corpo.append(h('div', { class: 'vazio' }, 'Conexão sem splitter cadastrado na Amigo.'));
        }

        elAbordagem = h('div', { class: 'abord' });
        elAbordUrgente = h('div', { class: 'abord-urgente', role: 'alert' });
        corpo.replaceChildren(elAbordUrgente, metricas, elAbordagem, sCliente.el, sEquip.el, sSplitter.el);
        atualizarIp();
        carregarAbordagem();
        // A ONU pode ter chegado antes da Amigo: redesenha para incluir o botão "Verificar caixa".
        if (estado.onu && estado.onuExibida === estado.etiqueta) renderOnu(estado.onu);
    }

    /** Texto de teste com o que estiver na tela agora (Amigo + ONU + caixa verificada). */
    function textoDoTeste() {
        return montarTextoDiagnostico(tipoDoTeste(estado.amigo, estado.onu), estado.amigo, estado.onu,
            { splitter: estado.splitterNome, caixa: estado.caixa });
    }

    // ---------- ONU (AutoISP) ----------

    // ---------- Abordagem (Amigo × AutoISP) ----------
    // Uma linha de etiquetas (✓ ok, ✗ faltando, ! diferente, ○ sem dado); detalhes na dica (passar o mouse).
    // Se faltar na Amigo um dado que o AutoISP tem (Slot/Porta OLT, ID ONU): faixa vermelha no topo do painel com o
    // botão "Abrir na Amigo já preenchido". A extensão abre a edição e preenche; QUEM SALVA É O ATENDENTE.

    const ICONE_ESTADO = {
        ok: ['✓', 'ok'], preenchido: ['✓', 'ok'], faltando: ['✗', 'erro'], divergente: ['!', 'aviso'],
        'depende-splitter': ['○', 'neutro'], 'sem-dado': ['○', 'neutro']
    };
    const NOTA_ESTADO = {
        ok: 'Igual ao AutoISP.',
        preenchido: 'Preenchido na Amigo (o AutoISP não tem o dado para conferir).',
        faltando: 'Vazio na Amigo; o AutoISP tem o valor (preencha na Amigo).',
        divergente: 'Diferente do AutoISP: confira. A extensão não altera valores já preenchidos.',
        'depende-splitter': 'Vazio na Amigo: só é gravado junto com o Splitter (CTO).',
        'sem-dado': 'O AutoISP não tem este dado.'
    };
    /** Consulta a Abordagem quando Amigo e ONU já responderam (a Amigo lê a página /edit em prioridade baixa). */
    function carregarAbordagem(forcar = false) {
        if (!elAbordagem || !estado.amigo || !estado.onuFinal) return;
        const seq = ++estado.abordSeq, dono = estado.seq;
        enviarMensagem({ action: 'abordagem', etiqueta: estado.etiqueta, usuario: estado.onuUsuario, forcar: forcar === true })
            .then(r => { if (seq === estado.abordSeq && dono === estado.seq && !estado.destruido) renderAbordagem(r.data); })
            .catch(e => {
                if (seq !== estado.abordSeq || dono !== estado.seq || estado.destruido) return;
                elAbordagem.replaceChildren(h('span', { class: 'abord-rot' }, 'Abordagem'),
                    h('span', { class: 'badge badge-neutro', title: e.message }, '○ não foi possível conferir'));
            });
    }

    function renderAbordagem(r) {
        const etiquetas = r.itens.map(i => {
            const [simbolo, tipo] = ICONE_ESTADO[i.estado] || ICONE_ESTADO['sem-dado'];
            const dica = `${i.rotulo}\nAmigo: ${i.amigo || 'vazio'}\nAutoISP: ${i.autoisp || 'sem dado'}\n${NOTA_ESTADO[i.estado] || ''}`;
            return h('span', { class: `badge badge-${tipo}`, title: dica }, `${simbolo} ${i.rotulo}`);
        });
        elAbordagem.replaceChildren(
            h('span', { class: 'abord-rot', title: r.temOnu ? 'Amigo × AutoISP' : 'O AutoISP não tem ONU para este cliente' }, 'Abordagem'),
            ...etiquetas);
        renderAbordUrgente(r);
    }

    /** Faixa vermelha no topo do painel quando falta na Amigo um dado que o AutoISP tem. */
    function renderAbordUrgente(r, nota = null) {
        if (!elAbordUrgente) return;
        const faltando = r.itens.filter(i => i.estado === 'faltando');
        if (!r.totalPreencher || !faltando.length) {
            estado.abordPendente = false;
            elAbordUrgente.replaceChildren();
            return;
        }
        const btn = botao('Abrir na Amigo já preenchido', {
            ic: 'externo', titulo: 'Abre a edição da conexão na Amigo com os campos preenchidos. Você confere e clica em Salvar.',
            onclick: () => abrirAmigoPreenchida(r, btn)
        });
        elAbordUrgente.replaceChildren(
            icone('alerta', 20),
            h('div', {},
                h('strong', {}, 'ABORDAGEM INCOMPLETA NA AMIGO'),
                h('div', { class: 'abord-falta' },
                    `Faltando: ${faltando.map(i => `${i.rotulo} (AutoISP: ${i.autoisp})`).join(' · ')}. Corrija antes de seguir com o atendimento.`),
                btn,
                nota ? h('div', { class: 'abord-nota' }, nota) : null));
    }

    async function abrirAmigoPreenchida(r, btn) {
        btn.disabled = true;
        rotularBotao(btn, 'Abrindo a Amigo…', null, true);
        const dono = estado.seq;
        try {
            await enviarMensagem({ action: 'abrirAbordagemPreenchida', etiqueta: estado.etiqueta, usuario: estado.onuUsuario, idConexao: r.idConexao });
            if (dono !== estado.seq || estado.destruido) return;
            estado.abordPendente = true; // ao voltar para o Zendesk, confere de novo
            renderAbordUrgente(r, 'A página da Amigo foi aberta com os campos preenchidos. Confira e clique em SALVAR lá. Ao voltar, a extensão confere sozinha.');
        } catch (e) {
            if (dono !== estado.seq || estado.destruido) return;
            renderAbordUrgente(r, `Não foi possível abrir: ${e.message}`);
            if (e.codigo === 'MUDOU') carregarAbordagem(true);
        }
    }

    function renderOnu(o) {
        estado.onu = o;
        atualizarIp();
        const st = o.statusOnu || {};
        const tipoSt = st.estado === 'online' ? 'ok' : st.estado === 'offline' ? 'erro' : 'neutro';
        const s = o.sinal;
        const cls = s && s.classificacao;
        const sinalNo = s
            ? h('span', { class: 'st' + (cls ? ` st-${cls.tipo}` : '') }, h('span', { class: 'mono', style: 'font-weight:600' }, s.texto),
                cls ? h('span', { class: 'badge badge-' + cls.tipo }, cls.rotulo) : null)
            : null;
        const eventos = (o.eventos || []).filter(e => e.texto);
        // Problema na ONU (LOS, DGI, Down, massiva): destaque com o teste + O.S. pronto para o ticket.
        const problema = st.problema && MODELOS_DIAGNOSTICO[st.problema]
            ? alerta(/^massiva/.test(st.problema) ? 'aviso' : 'erro',
                `${MODELOS_DIAGNOSTICO[st.problema].titulo}${st.quando ? ` desde ${formatarDataIso(st.quando)}` : ''}. ${MODELOS_DIAGNOSTICO[st.problema].analise}`,
                h('div', { class: 'cto-acoes' },
                    botaoCopiarTexto(/^massiva/.test(st.problema) ? 'Copiar teste (massiva)' : 'Copiar teste + O.S.', textoDoTeste, { pequeno: false }),
                    estado.verificarCaixa
                        ? botao('Verificar caixa', { ic: 'pulso', pequeno: true, titulo: 'Verifica quem está online no splitter do cliente (vai para o teste)', onclick: () => estado.verificarCaixa() })
                        : null))
            : null;
        const ip = o.sessao && o.sessao.ip;
        const semVinculo = !o.olt && !o.ponlink && !o.serial;
        const at = o.statusAtual || null; // "Status GPON" atual do AutoISP (websocket)
        const btnLer = o.gponId ? botao('Ler agora na OLT', {
            ic: 'atualizar', pequeno: true, titulo: 'Pede uma leitura nova na OLT (como ao abrir a ONU no AutoISP) — cerca de 15 s',
            onclick: () => carregarOnu(estado.etiqueta, estado.amigo && estado.amigo.usuarioRadius, true, estado.seq, true)
        }) : null;
        // Atenção: replaceChildren(null) vira o texto "null" — por isso o filter(Boolean) no fim.
        sOnu.corpo.replaceChildren(...[
            estado.elLeitura = h('div', { class: 'nota', style: 'margin-bottom:8px', hidden: true }),
            problema ? h('div', { style: 'margin-bottom:10px' }, problema) : null,
            o.statusAtualErro ? h('div', { class: 'detalhe', style: 'margin-bottom:8px' },
                `Status atual do AutoISP indisponível (${o.statusAtualErro}). Mostrando o histórico.`) : null,
            semVinculo ? h('div', { style: 'margin-bottom:10px' },
                alerta('info', 'O AutoISP não tem OLT nem PON vinculados a este cliente (ONU desvinculada ou não provisionada).')) : null,
            grade(
                campo('Status da ONU', null, {
                    // Sem status atual e sem eventos de queda/retorno: não há como afirmar o estado.
                    no: st.texto ? badge(st.texto, tipoSt) : badge('Sem informação', 'neutro'),
                    detalhe: [st.estado === 'offline' && st.quando ? `desde ${formatarDataIso(st.quando)}` : '',
                        st.fonte === 'status' ? 'status atual do AutoISP' : (st.texto ? 'pelo histórico' : '')]
                        .filter(Boolean).join(' · ') || null
                }),
                campo('Sinal RX ONU', null, {
                    no: sinalNo || h('span', { class: 'vazio' }, '—'),
                    detalhe: s ? (s.atual ? 'atual' : s.quando ? `última leitura ${formatarDataIso(s.quando)}` : null) : null
                }),
                at && at.rxOlt ? campo('Sinal RX OLT', at.rxOlt, { mono: true }) : null,
                at && at.distancia ? campo('Distância', at.distancia) : null,
                at && at.modelo ? campo('Modelo da ONU', at.modelo, { mono: true, detalhe: at.fabricanteId || null }) : null,
                at && at.firmware ? campo('Firmware', at.firmware, { mono: true }) : null,
                // Com a ONU online, onu_last_off é quando ela voltou (bate com o "UP" do histórico), não uma queda.
                at && at.ultimoOff ? campo(at.estado === 'online' ? 'Última mudança de estado' : 'Último desligamento', formatarDataIso(at.ultimoOff), { detalhe: at.causaOff ? `causa: ${at.causaOff}` : null, largo: true }) : null,
                campo('Última queda (histórico)', o.ultimaQueda ? o.ultimaQueda.texto : '', {
                    detalhe: o.ultimaQueda && o.ultimaQueda.quando ? formatarDataIso(o.ultimaQueda.quando) : null, largo: true
                }),
                campo('OLT', o.olt, { mono: true, largo: true }),
                campoIpOlt(o),
                campo('PON', o.ponlink, { mono: true }),
                campo('ID da ONU', o.onuId, { mono: true, copiar: true }),
                campo('Service port', o.servicePort, { mono: true, copiar: true }),
                campo('VLAN', o.vlan, { mono: true }),
                o.cto ? campo('CTO (AutoISP)', o.cto, { largo: true }) : null,
                o.perfilOnu ? campo('Perfil da ONU', o.perfilOnu, { mono: true, largo: true }) : null,
                campo(o.sessao && o.sessao.fim ? 'Último IP' : 'IP', ip, {
                    mono: true, copiar: true, largo: true,
                    detalhe: o.sessao && o.sessao.inicio ? `sessão desde ${formatarDataIso(o.sessao.inicio)}` : null
                }),
                o.descricaoOlt ? campo('Descrição na OLT', o.descricaoOlt, { largo: true }) : null
            ),
            eventos.length > 1
                ? h('div', { class: 'detalhe', style: 'margin-top:8px' },
                    'Últimos eventos: ' + eventos.map(e => `${formatarDataIso(e.quando)} ${e.texto}`).join(' · '))
                : null,
            h('div', { class: 'cto-acoes', style: 'margin-top:10px' },
                problema ? null : botaoCopiarTexto('Copiar teste', textoDoTeste),
                btnLer,
                o.link ? botao('Print na observação interna', {
                    ic: 'camera', pequeno: true,
                    titulo: 'Tira o print da ONU no AutoISP (em segundo plano, até 30 s) e salva numa observação interna deste ticket',
                    onclick: () => salvarPrint(o)
                }) : null,
                o.link ? link('Abrir ONU no AutoISP', { titulo: 'Abrir a ONU no AutoISP', onclick: () => abrirUrl(o.link) }) : null),
            elPrintMsg
        ].filter(Boolean));
    }

    // ---------- IP da OLT (OLT = Ponto de acesso / uPE) ----------

    /** Campo "IP da OLT": AutoISP pelo ID da OLT; se faltar, Amigo (Ativos de Rede) pelo nome do uPE. */
    function campoIpOlt(o) {
        const c = estado.amigo && estado.amigo.conexao;
        const pedido = { oltId: o.oltId || '', pontoAcesso: (c && c.pontoAcesso) || '', olt: o.olt || '' };
        if (!pedido.oltId && !pedido.pontoAcesso && !pedido.olt) return null;
        const chave = JSON.stringify(pedido);
        const valor = h('div', { class: 'valor' }, h('span', { class: 'vazio' }, 'buscando…'));
        const el = h('div', { class: 'campo largo' }, h('div', { class: 'rotulo' }, 'IP da OLT'), valor);
        const mostrar = r => {
            estado.ipOlt = { chave, r };
            valor.replaceChildren(...(r && r.ip
                ? [h('span', { class: 'mono' }, r.ip), botaoCopiar(r.ip), h('span', { class: 'detalhe' }, `fonte: ${r.fonte}`),
                    // Logo abaixo do IP: abre a busca do Zabbix por este IP (nova aba, sessão do atendente).
                    h('div', { style: 'flex-basis:100%' }, link('Abrir no ZABBIX', {
                        titulo: `Buscar ${r.ip} no Zabbix`, onclick: () => abrirUrl(urlZabbixIp(r.ip))
                    }))]
                : [h('span', { class: 'vazio' }, 'não encontrado')]));
        };
        if (estado.ipOlt && estado.ipOlt.chave === chave) mostrar(estado.ipOlt.r);
        else {
            const dono = estado.seq;
            enviarMensagem({ action: 'ipOlt', ...pedido })
                .then(r => { if (dono === estado.seq && !estado.destruido) mostrar(r.data); })
                .catch(e => { if (dono === estado.seq && !estado.destruido) valor.replaceChildren(h('span', { class: 'vazio', title: e.message }, 'indisponível')); });
        }
        return el;
    }

    // ---------- Print da ONU na observação interna ----------
    // Print da página da ONU no AutoISP (aberta em segundo plano e desenhada em imagem, até ~30 s), gravado
    // numa observação INTERNA (public:false) quando o atendente clica no botão.

    async function salvarPrint(o) {
        if (estado.salvandoPrint) return;
        estado.salvandoPrint = true;
        const dono = estado.seq;
        const etiqueta = estado.etiqueta || '';
        elPrintMsg.replaceChildren(nota('Tirando o print da ONU no AutoISP e salvando na observação interna… (até 30 s)'));
        try {
            const blob = dataUrlParaBlob((await enviarMensagem({ action: 'printAutoIsp', link: o.link })).dataUrl);
            const quando = new Date();
            const carimbo = `${quando.toLocaleDateString('pt-BR')} ${formatarHora(quando.getTime())}`;
            const arquivo = `onu-${etiqueta.replace(/[^A-Za-z0-9_-]/g, '') || 'cliente'}-${quando.toISOString().slice(0, 16).replace(/[-:T]/g, '')}.${blob.type === 'image/png' ? 'png' : 'jpg'}`;
            const html = '<p><strong>Print da ONU no AutoISP</strong>' +
                ` — etiqueta ${escaparHtml(etiqueta)} — ${escaparHtml(carimbo)}</p><p>Gerado pelo Assistente de Diagnóstico.</p>`;
            await salvarNotaInterna(ticketAtual(), blob, arquivo, html);
            if (dono !== estado.seq || estado.destruido) return;
            elPrintMsg.replaceChildren(alerta('ok', `Salvo na observação interna às ${formatarHora(Date.now())}.`));
        } catch (e) {
            if (dono !== estado.seq || estado.destruido) return;
            elPrintMsg.replaceChildren(alerta('erro', `Não foi salvo: ${(e && e.message) || 'erro inesperado.'}`,
                botao('Tentar de novo', { ic: 'atualizar', pequeno: true, onclick: () => salvarPrint(o) })));
        } finally {
            estado.salvandoPrint = false;
        }
    }

    /** Número do ticket deste painel (ou o da URL, se o campo não informar). */
    function ticketAtual() {
        if (ticketId) return ticketId;
        const m = /\/agent\/tickets\/(\d+)/.exec(location.pathname);
        return m ? m[1] : null;
    }

    /** IP da conexão: o do AutoISP (mais confiável) quando houver; senão, o da Amigo. */
    function atualizarIp() {
        if (!elIp) return;
        const sOnuSessao = estado.onu && estado.onu.sessao;
        const ipAutoIsp = sOnuSessao && sOnuSessao.ip;
        const ip = ipAutoIsp || (estado.amigo && estado.amigo.ip) || '';
        const encerrada = ipAutoIsp ? !!sOnuSessao.fim : !(estado.amigo && estado.amigo.estado === 'online');
        elIpRotulo.textContent = encerrada ? 'Último IP' : 'IP atual';
        elIp.replaceChildren(ip
            ? h('span', { class: 'mono', title: ipAutoIsp ? 'IP da sessão no AutoISP' : 'IP informado pela Amigo' }, ip,
                h('span', { class: 'un', style: 'font-family:inherit' }, ipAutoIsp ? ' AutoISP' : ' Amigo'))
            : h('span', { class: 'vazio' }, '—'));
        // Logo abaixo do IP: teste das portas do roteador (lista do NMAP da equipe) e link para acessar.
        if (elIpAcesso) {
            // Só com sessão ATIVA: o "Último IP" de uma conexão desconectada pode já ser de outro cliente,
            // então não testa portas nem oferece "Acessar roteador" (pedido do usuário em 26/11/2026).
            if (!IPV4_VALIDO.test(ip) || encerrada) { elIpAcesso.replaceChildren(); return; }
            if (estado.portas && estado.portas.ip === ip) renderPortas(estado.portas, encerrada);
            else if (estado.portasPedido !== ip) testarPortasRoteador(ip, encerrada, false);
        }
    }

    // ---------- Teste de portas do roteador ----------
    // Roda sozinho quando o IP aparece (uma vez por IP; o service worker guarda 5 min). Mostra se o roteador
    // responde por web e em qual porta; o link "Acessar roteador" abre na porta que respondeu.

    /**
     * Teste de portas pelo service worker. Sem a permissão "Acesso à rede local" da extensão, NÃO pede nada
     * sozinho: mostra "Ativar teste de portas (uma vez)", que abre a janelinha onde o Chrome pergunta. Ao voltar
     * para o Zendesk (foco na janela), o teste roda de novo.
     */
    function testarPortasRoteador(ip, encerrada, forcar) {
        estado.portasPedido = ip;
        const dono = estado.seq;
        const ainda = () => dono === estado.seq && !estado.destruido;
        const acessoSimples = () => link('Acessar roteador', { titulo: `Abre http://${ip} numa guia nova`, onclick: () => abrirRoteador(`http://${ip}/`) });
        elIpAcesso.replaceChildren(nota('Testando as portas do roteador…'));
        enviarMensagem({ action: 'testarPortas', ip, forcar: forcar === true })
            .then(r => {
                if (!ainda()) return;
                const d = r.data;
                estado.portas = d;
                const algumaAberta = d.portas.some(p => p.estado === 'aberta');
                // Nenhuma porta respondeu e a permissão de rede local não está confirmada: oferece ativar
                // (pode ser o Chrome barrando, não o roteador). Com alguma porta aberta, o resultado manda.
                if (!algumaAberta && d.permissao === 'prompt') {
                    estado.portasAguardandoPermissao = ip;
                    renderPortas(d, encerrada);
                    elIpAcesso.append(h('button', {
                        type: 'button', class: 'link',
                        title: 'Abre uma janelinha onde o Chrome pede UMA vez para a extensão "acessar dispositivos na rede local". Clique em Permitir; depois o teste roda sozinho em todos os tickets.',
                        onclick: () => enviarMensagem({ action: 'ativarRedeLocal', ip }).catch(() => {})
                    }, 'Ativar teste de portas (uma vez)'));
                    return;
                }
                estado.portasAguardandoPermissao = null;
                renderPortas(d, encerrada);
                if (!algumaAberta && d.permissao === 'denied') {
                    elIpAcesso.append(h('span', { class: 'detalhe', title:
                        'Para liberar: abra chrome://settings/content › Acesso à rede local e remova o bloqueio do "Assistente de Diagnóstico Zendesk". Depois recarregue o Zendesk.' },
                    'rede local bloqueada no Chrome (passe o mouse)'));
                }
            })
            .catch(e => {
                if (!ainda()) return;
                estado.portasPedido = null;
                elIpAcesso.replaceChildren(acessoSimples(), h('span', { class: 'detalhe' }, `Teste de portas indisponível: ${e.message}`));
            });
    }

    function renderPortas(r, encerrada) {
        const por = e => r.portas.filter(p => p.estado === e).map(p => p.porta);
        const abertas = r.portas.filter(p => p.estado === 'aberta');
        const dica = [
            `Portas testadas em ${r.ip} (${Math.round(r.duracaoMs / 100) / 10} s):`,
            `abertas (web): ${por('aberta').join(', ') || 'nenhuma'}`,
            `fechadas ou não-web: ${por('fechada').join(', ') || '—'}`,
            `sem resposta: ${por('sem-resposta').join(', ') || '—'}`,
            `HTTPS inconclusiva (certificado): ${por('inconclusiva').join(', ') || '—'}`,
            `não testáveis no navegador: ${por('nao-testavel').join(', ') || '—'} (SSH/Telnet bloqueadas pelo Chrome)`,
            'Portas abertas que não usam web (ex.: Winbox 8291) aparecem como fechadas.',
            (() => { // diagnóstico: erro e tempo da porta 80
                const p80 = r.portas.find(p => p.porta === 80);
                return p80 ? `Porta 80: ${p80.estado} em ${p80.ms} ms${p80.erro ? ` — erro do navegador: ${p80.erro}` : ''}` : '';
            })(),
            encerrada ? 'Atenção: sessão encerrada — o IP pode ter mudado.' : ''
        ].filter(Boolean).join('\n');
        const repetir = h('button', { type: 'button', class: 'link', title: 'Testar as portas de novo',
            onclick: () => testarPortasRoteador(r.ip, encerrada, true) }, 'testar de novo');
        if (abertas.length) {
            const [primeira, ...outras] = abertas;
            elIpAcesso.replaceChildren(
                h('span', { class: 'portas-ok', title: dica }, `✓ porta ${abertas.map(p => p.porta).join(', ')}`),
                link('Acessar roteador', { titulo: `Abre ${primeira.url} numa guia nova`, onclick: () => abrirRoteador(primeira.url) }),
                ...outras.slice(0, 3).map(p => h('button', { type: 'button', class: 'link', title: `Abre ${p.url}`,
                    onclick: () => abrirRoteador(p.url) }, `:${p.porta}`)));
        } else {
            elIpAcesso.replaceChildren(
                h('span', { class: 'portas-nao', title: dica }, `✗ nenhuma porta web respondeu (${r.portas.length} testadas)`),
                repetir);
        }
    }

    /**
     * Busca os dados da ONU. Normal: status atual (tabela de diagnóstico) + cadastro (< 1 s). aoVivo (botão
     * "Ler agora na OLT"): pede leitura nova na OLT (~15 s), mantendo os dados na tela enquanto lê.
     * seqDono: consulta da Amigo dona deste pedido.
     */
    function carregarOnu(etiqueta, usuario, forcar, seqDono, aoVivo = false) {
        const minha = ++estado.onuSeq;
        estado.onuNaoAchada = false;
        if (!aoVivo) estado.onuFinal = false;
        // Fim da consulta (achou ou não): libera a conferência da Abordagem.
        const terminou = () => { estado.onuFinal = true; estado.onuUsuario = usuario || null; carregarAbordagem(); };
        sOnu.el.hidden = false;
        if (aoVivo && estado.elLeitura && estado.onuExibida === etiqueta) {
            estado.elLeitura.hidden = false;
            estado.elLeitura.replaceChildren(h('span', { class: 'giro' }), 'Lendo a ONU na OLT… (cerca de 15 s)');
        } else if (!estado.onuExibida || estado.onuExibida !== etiqueta) {
            estado.onu = null; // não mistura IP/dados da ONU de outra etiqueta
            sOnu.corpo.replaceChildren(nota(aoVivo ? 'Lendo a ONU na OLT… (cerca de 15 s)' : 'Consultando o AutoISP…'));
        }
        enviarMensagem({ action: 'consultarOnu', etiqueta, usuario, forcar, aoVivo })
            .then(r => {
                if (minha !== estado.onuSeq || estado.destruido || seqDono !== estado.seq) return;
                renderOnu(r.data);
                estado.onuExibida = etiqueta;
                terminou();
            })
            .catch(e => {
                if (minha !== estado.onuSeq || estado.destruido || seqDono !== estado.seq) return;
                if (aoVivo && estado.onuExibida === etiqueta && estado.elLeitura) {
                    // Falhou a leitura ao vivo: mantém os dados que já estão na tela e avisa.
                    estado.elLeitura.replaceChildren(alerta('aviso', `Leitura ao vivo indisponível: ${e.message}`));
                    return;
                }
                estado.onuExibida = null;
                if (e.codigo === 'NAO_ENCONTRADO') {
                    const naoAchou = () => { sOnu.corpo.replaceChildren(h('div', { class: 'vazio' }, e.message)); terminou(); };
                    if (usuario) return naoAchou();
                    // Não achou pela etiqueta: tenta pelo usuário PPPoE da Amigo (agora, se já chegou; senão, quando chegar).
                    const fim = estado.amigoFim;
                    if (fim && fim.seq === seqDono) {
                        if (fim.usuario) carregarOnu(etiqueta, fim.usuario, forcar, seqDono);
                        else naoAchou();
                        return;
                    }
                    estado.onuNaoAchada = true;
                    sOnu.corpo.replaceChildren(h('div', { class: 'vazio' }, 'Procurando a ONU pelo usuário PPPoE…'));
                    return;
                }
                const acao = e.codigo === 'LOGIN_AUTOISP'
                    ? link('Abrir login do AutoISP', { onclick: () => abrirUrl(AUTOISP_ORIGEM + '/users/sign_in') })
                    : null;
                sOnu.corpo.replaceChildren(alerta('aviso', e.message, acao));
                terminou();
            });
    }

    /** manual = botão "Atualizar" (ignora o cache). Automático: ao abrir/voltar ao ticket. */
    function consultar(manual = false) {
        const etiqueta = input.value.trim();
        if (!etiqueta) {
            if (manual) mostrarSemEtiqueta('Preencha a "Etiqueta do cliente" para consultar.', 'aviso');
            return;
        }
        if (!ETIQUETA_VALIDA.test(etiqueta)) {
            estado.etiqueta = etiqueta;
            mostrarSemEtiqueta('A etiqueta contém caracteres inválidos.', 'erro');
            return;
        }
        cancelarTudo(); // verificações em massa do diagnóstico anterior
        const seq = ++estado.seq;
        estado.etiqueta = etiqueta;
        estado.carregadoEm = Date.now();
        definirCarregando(true);
        carregarOnu(etiqueta, null, manual, seq); // AutoISP em paralelo (outro servidor, outra fila)
        // Reconsulta da mesma etiqueta: mantém o resultado anterior na tela (a altura do painel não muda
        // enquanto o atendente rola o menu); só o indicador de status mostra que está atualizando.
        if (estado.temResultado && estado.etiquetaExibida === etiqueta) {
            elResumo.replaceChildren(indicador('carregando', 'Atualizando…'));
        } else {
            estado.temResultado = false;
            renderCarregando(etiqueta);
        }
        enviarMensagem({ action: 'consultarCliente', etiqueta, forcar: manual })
            .then(r => {
                if (seq !== estado.seq || estado.destruido) return;
                const d = r.data;
                renderResultado(d);
                estado.temResultado = true;
                estado.etiquetaExibida = etiqueta;
                // ONU não achada pela etiqueta: tenta de novo com o usuário PPPoE que a Amigo informou.
                estado.amigoFim = { seq, usuario: d.usuarioRadius || null };
                if (estado.onuNaoAchada) {
                    if (d.usuarioRadius) carregarOnu(etiqueta, d.usuarioRadius, manual, seq);
                    else {
                        sOnu.corpo.replaceChildren(h('div', { class: 'vazio' }, 'ONU não encontrada no AutoISP para esta etiqueta.'));
                        estado.onuFinal = true;
                        carregarAbordagem();
                    }
                }
                info.textContent = `Consulta às ${formatarHora(d.consultadoEm)}${d.doCache ? ' (recente)' : ''}`;
                if (d.estado === 'indeterminado') estado.carregadoEm = 0; // tenta de novo ao voltar ao ticket
            })
            .catch(e => {
                if (seq !== estado.seq || estado.destruido) return;
                estado.carregadoEm = 0;
                estado.temResultado = false;
                estado.amigoFim = { seq, usuario: null };
                if (estado.onuNaoAchada) sOnu.corpo.replaceChildren(h('div', { class: 'vazio' }, 'ONU não encontrada no AutoISP para esta etiqueta.'));
                info.textContent = '';
                renderErro(e);
            })
            .finally(() => { if (seq === estado.seq) definirCarregando(false); });
    }
    btnAtualizar.addEventListener('click', () => consultar(true));

    // Etiqueta editada pelo atendente (ao sair do campo): consulta de novo.
    const aoMudarEtiqueta = () => {
        const etq = input.value.trim();
        if (estado.ativo && etq && etq !== estado.etiqueta) consultar(false);
    };
    input.addEventListener('change', aoMudarEtiqueta);

    mostrarSemEtiqueta('Preencha a "Etiqueta do cliente" para ver o diagnóstico.');

    return {
        campoEl,
        host,
        ticketId,
        get ativo() { return estado.ativo; },
        definirAtivo(ativo) {
            if (ativo === estado.ativo) return;
            estado.ativo = ativo;
            raiz.toggleAttribute('data-ativo', ativo);
            // Reforço: painel de ticket fora de vista nunca recebe clique, rolagem ou foco.
            host.inert = !ativo;
            if (!ativo) { cancelarTudo(); return; }
            // Na troca de ticket o Zendesk está redesenhando a tela: nada de trabalho agora.
            // Visual e consulta esperam o navegador ficar ocioso.
            quandoOcioso(() => {
                if (!estado.ativo || estado.destruido) return;
                if (Date.now() - visualEm > 60000) aplicarVisual();
                const etq = input.value.trim();
                if (!etq) return;
                const vencido = !estado.carregadoEm || Date.now() - estado.carregadoEm > RECARREGAR_APOS_MS;
                if (etq !== estado.etiqueta || vencido) consultar(false);
            }, 1500);
        },
        /** Chamado a cada varredura: o Zendesk às vezes preenche o campo depois de desenhá-lo. */
        verificarPreenchimento() {
            if (estado.ativo && estado.etiqueta === null && input.value.trim()) consultar(false);
        },
        destruir() {
            estado.destruido = true;
            cancelarTudo();
            input.removeEventListener('change', aoMudarEtiqueta);
            host.remove();
        }
    };
}

// ==========================================
// 5. VARREDURA E TICKET ATIVO
// ==========================================

const paineis = new Map(); // elemento do campo → painel

function localizarCampos() {
    const porId = document.querySelectorAll(SELETOR_CAMPO);
    if (porId.length) return [...porId];
    // Plano B (o ID do campo mudou): procura pelo rótulo, só dentro da coluna de campos dos tickets.
    const achados = [];
    document.querySelectorAll('#ticket_sidebar label, [data-test-id="component-type-TicketFieldsPane"] label').forEach(l => {
        if (!l.textContent.trim().startsWith(ROTULO_CAMPO)) return;
        const f = l.closest('[data-garden-id="forms.field"]') || l.parentElement;
        if (f && f.querySelector('input') && !achados.includes(f)) achados.push(f);
    });
    return achados;
}

/** Painel ativo = pertence ao ticket da URL. Sem número de ticket, vale a visibilidade real do painel. */
function atualizarAtivos() {
    const atual = ticketDaUrl();
    for (const p of paineis.values()) {
        const ativo = p.ticketId ? p.ticketId === atual : (!!atual && getComputedStyle(p.host).visibility === 'visible');
        p.definirAtivo(ativo);
    }
}

function varrer() {
    for (const [campoEl, p] of paineis) {
        if (!campoEl.isConnected) { p.destruir(); paineis.delete(campoEl); continue; }
        // O Zendesk redesenhou a coluna e tirou o painel: recoloca (mantém o estado).
        if (!p.host.isConnected) campoEl.insertAdjacentElement('afterend', p.host);
    }
    for (const campoEl of localizarCampos()) {
        if (paineis.has(campoEl)) continue;
        const p = criarPainelTicket(campoEl);
        if (p) paineis.set(campoEl, p);
    }
    atualizarAtivos();
    for (const p of paineis.values()) p.verificarPreenchimento();
}

// Limita a varredura a ~2 por segundo e a roda em momento ocioso (depois que o Zendesk termina de
// redesenhar). Diferente de um debounce puro, nunca fica adiada para sempre: no máximo ~1,5 s.
const INTERVALO_VARREDURA_MS = 500;
let varreduraPendente = false, ultimaVarredura = 0;
function agendarVarredura() {
    if (varreduraPendente) return;
    varreduraPendente = true;
    const espera = Math.max(0, INTERVALO_VARREDURA_MS - (Date.now() - ultimaVarredura));
    setTimeout(() => quandoOcioso(() => {
        varreduraPendente = false;
        ultimaVarredura = Date.now();
        varrer();
    }, 1000), espera);
}

/**
 * Só agenda varredura quando o Zendesk adiciona/remove ELEMENTOS. Mudanças só de texto (relógios
 * "há 5 minutos", contadores) são a maioria e não interessam.
 */
function aoMudarDom(registros) {
    for (const r of registros) {
        for (const n of r.addedNodes) if (n.nodeType === 1) return agendarVarredura();
        for (const n of r.removedNodes) if (n.nodeType === 1) return agendarVarredura();
    }
}

/** Versões ≤ 2.5 guardavam a chave da IA no localStorage do Zendesk; apaga se ainda existir. */
function limparChaveAntiga() {
    try {
        localStorage.removeItem('geminiApiKeyExt');
    } catch (e) { /* storage bloqueado */ }
}

// ==========================================
// 6. PLATAFORMA AMIGO: BOTÃO "AutoISP ↗" (igual à v4.1)
// ==========================================

function injetarBotaoAmigo() {
    const tabela = document.querySelector('table');
    if (!tabela) return;
    const cabecalhos = Array.from(tabela.querySelectorAll('thead th'));
    const linhas = tabela.querySelectorAll('tbody tr');
    if (!linhas.length || !cabecalhos.length) return;

    let indice = cabecalhos.findIndex(th => th.textContent.trim().toLowerCase() === 'etiqueta');
    if (indice === -1) indice = cabecalhos.findIndex(th => th.textContent.trim().toLowerCase() === 'usuário ipoe');
    if (indice === -1) return;

    linhas.forEach(linha => {
        if (linha.querySelector('.btn-autoisp')) return;
        const celulas = linha.querySelectorAll('td');
        if (celulas.length <= indice) return;
        const termo = celulas[indice].textContent.trim();
        if (!termo) return;

        // Usa as classes Bootstrap da própria Amigo para combinar com o visual da página.
        const btn = h('a', {
            class: 'btn-autoisp btn btn-sm btn-success',
            style: 'margin-left:8px;cursor:pointer;white-space:nowrap;',
            title: 'Buscar no AutoISP',
            onclick: e => { e.preventDefault(); abrirUrl(AUTOISP_BUSCA + encodeURIComponent(termo)); }
        }, 'AutoISP ↗');

        const ultima = celulas[celulas.length - 1];
        ultima.style.display = 'flex';
        ultima.style.alignItems = 'center';
        ultima.appendChild(btn);
    });
}

// ==========================================
// 6c. PRINT DA ONU: gravação da observação interna (Zendesk) e captura da página (AutoISP)
// ==========================================

const esperarMs = ms => new Promise(r => setTimeout(r, ms));

async function esperarAte(teste, limiteMs, passoMs = 250) {
    const fim = Date.now() + limiteMs;
    for (;;) {
        const v = teste();
        if (v) return v;
        if (Date.now() > fim) return null;
        await esperarMs(passoMs);
    }
}

const escaparHtml = t => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** data:image/...;base64 → Blob (sem fetch: o CSP da página pode bloquear data:). */
function dataUrlParaBlob(dataUrl) {
    const m = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
    if (!m) throw new ErroExtensao('O print recebido é inválido.');
    const bin = atob(m[2]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: m[1] });
}

/** Token CSRF da sessão do atendente no Zendesk (meta da página; reserva: /api/v2/users/me). */
async function tokenCsrfZendesk() {
    const meta = document.querySelector('meta[name="csrf-token"]');
    if (meta && meta.content) return meta.content;
    const r = await fetch(location.origin + '/api/v2/users/me.json', { credentials: 'same-origin' });
    const j = r.ok ? await r.json().catch(() => null) : null;
    return (j && j.user && j.user.authenticity_token) || null;
}

/**
 * Grava uma observação INTERNA no ticket com a imagem anexada, pela API do Zendesk com a sessão do próprio
 * atendente: 1) envia o anexo (/api/v2/uploads), 2) adiciona o comentário com public:false. Só o comentário
 * vai no PUT: nenhum outro campo do ticket é alterado.
 */
async function salvarNotaInterna(ticket, blob, nomeArquivo, html) {
    if (!/^\d{1,12}$/.test(String(ticket || ''))) throw new ErroExtensao('Não foi possível identificar o número do ticket.');
    if (!(blob instanceof Blob) || !/^image\/(png|jpeg)$/.test(blob.type) || blob.size > 10 * 1024 * 1024) {
        throw new ErroExtensao('Imagem inválida ou grande demais.');
    }
    const csrf = await tokenCsrfZendesk();
    if (!csrf) throw new ErroExtensao('Sessão do Zendesk não encontrada. Recarregue a página (F5).');
    const base = location.origin;
    const up = await fetch(`${base}/api/v2/uploads.json?filename=${encodeURIComponent(nomeArquivo)}`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': blob.type, 'X-CSRF-Token': csrf }, body: blob
    });
    if (!up.ok) throw new ErroExtensao(`O Zendesk recusou o anexo (HTTP ${up.status}).`);
    const tokenAnexo = ((await up.json().catch(() => null)) || {}).upload?.token;
    if (!tokenAnexo) throw new ErroExtensao('O Zendesk não devolveu o anexo.');
    const put = await fetch(`${base}/api/v2/tickets/${ticket}.json`, {
        method: 'PUT', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ ticket: { comment: { html_body: html, public: false, uploads: [tokenAnexo] } } })
    });
    if (!put.ok) throw new ErroExtensao(`O Zendesk não salvou a observação (HTTP ${put.status}).`);
}

// --- Lado do AutoISP: aba aberta pelo service worker com #zx-print=<token> ---

const PREFIXO_PRINT = '#zx-print=';

/** "Atualizado em: 10/11 12:19" (dia/mês hora:min, horário local) foi há menos de `minutos`? */
function leituraRecente(texto, minutos) {
    const m = /^(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/.exec(String(texto || '').trim());
    if (!m) return false;
    const agora = new Date();
    const quando = new Date(agora.getFullYear(), Number(m[2]) - 1, Number(m[1]), Number(m[3]), Number(m[4]));
    if (quando - agora > 24 * 3600 * 1000) quando.setFullYear(quando.getFullYear() - 1); // virada de ano
    const dif = agora - quando;
    return dif >= -60000 && dif < minutos * 60000;
}

async function capturarPrintAutoIsp() {
    const token = location.hash.slice(PREFIXO_PRINT.length);
    if (!/^[0-9a-f-]{36}$/i.test(token)) return;
    history.replaceState(null, '', location.pathname + location.search); // tira o token da barra de endereço
    const falhar = mensagem => enviarMensagem({ action: 'printErro', token, mensagem }).catch(() => {});
    try {
        await enviarMensagem({ action: 'printTarefa', token }); // confirma que a aba foi aberta pela extensão
        if (typeof html2canvas !== 'function') return falhar('Componente de captura indisponível. Recarregue a extensão.');
        // Card "Status GPON" da página da ONU.
        const acharCard = () => [...document.querySelectorAll('.col-xl-4, .col-lg-4, .col-md-4')]
            .find(e => /Status GPON/.test(e.innerText || '') && /Atualizado em/.test(e.innerText || ''));
        const card = await esperarAte(acharCard, 30000, 500);
        if (!card) return falhar('A página da ONU no AutoISP não mostrou o Status GPON.');
        // Ao abrir, a página pede leitura nova na OLT (~15 s). Leitura recente (< 3 min): tira na hora.
        // Senão espera o "Atualizado em" mudar por até 15 s (pode não mudar, ex. ONU sem sinal) — o horário
        // da leitura aparece no próprio print.
        const atualizado = () => ((card.innerText || '').match(/Atualizado em:\s*([\d/: ]+)/) || [])[1] || '';
        const inicial = atualizado();
        if (!leituraRecente(inicial, 3)) await esperarAte(() => atualizado() !== inicial, 15000, 500);
        await esperarMs(800); // gráficos terminarem de desenhar
        const linha = card.closest('.row') || card.parentElement;
        const largura = document.documentElement.clientWidth || window.innerWidth;
        const altura = Math.min(Math.ceil(linha.getBoundingClientRect().bottom + window.scrollY) + 12, 3000);
        const escala = Math.min(1, 1600 / largura);
        const canvas = await html2canvas(document.body, {
            x: 0, y: 0, width: largura, height: altura, windowWidth: largura, scrollX: 0, scrollY: 0,
            scale: escala, backgroundColor: '#ffffff', logging: false, useCORS: true
        });
        await enviarMensagem({ action: 'printPronto', token, dataUrl: canvas.toDataURL('image/jpeg', 0.85) });
    } catch (e) {
        falhar((e && e.message) || 'Falha ao gerar o print.');
    }
}

// ==========================================
// 6d. AMIGO: EDIÇÃO DA CONEXÃO ABERTA JÁ PREENCHIDA (o atendente é quem salva)
// ==========================================
//
// O service worker abre /connection/{id}/edit#zx-preencher=<token> à vista do atendente. Aqui os campos
// VAZIOS da Abordagem recebem os valores do AutoISP, ficam destacados e um aviso pede para conferir e
// clicar em Salvar. A extensão NUNCA clica em Salvar nem altera campo já preenchido.

const PREFIXO_PREENCHER = '#zx-preencher=';
// Sem Splitter (CTO) a Amigo esconde o campo real do ID ONU e mostra "connection[idOnuFake]": preenche os dois.
const CAMPOS_ABORDAGEM = {
    onuId: { rotulo: 'ID ONU', nomes: ['connectionApproach[0][onuId]', 'connection[idOnuFake]'] },
    // (Serial removido da extensão a pedido do usuário em 26/11/2026: não é preenchido nem exibido.)
    // Sem Splitter: campos de texto Slot/Porta OLT (gravam; com Splitter eles vêm da CTO e não são preenchidos).
    slot: { rotulo: 'Slot OLT', nomes: ['connection[slotOltFake]'] },
    porta: { rotulo: 'Porta OLT', nomes: ['connection[portOltFake]'] }
};

/** Define o valor como se fosse digitado (dispara os eventos que a página da Amigo escuta). */
function digitarNoCampo(el, valor) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, valor);
    for (const tipo of ['input', 'change', 'keyup', 'blur']) el.dispatchEvent(new Event(tipo, { bubbles: true }));
}

/** Aviso fixo no topo da página da Amigo (texto puro, sem HTML vindo de dados). */
function avisoNaAmigo(tipo, titulo, linhas = []) {
    document.getElementById('zx-aviso-abordagem')?.remove();
    const cor = tipo === 'ok' ? '#b45309' : '#b42318';
    const caixa = document.createElement('div');
    caixa.id = 'zx-aviso-abordagem';
    caixa.setAttribute('role', 'alert');
    caixa.style.cssText = `position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483000;max-width:640px;width:calc(100% - 32px);
        background:#fff;color:#1f2d3d;border:3px solid ${cor};border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.25);
        padding:12px 40px 12px 14px;font:14px/1.45 "Segoe UI",Arial,sans-serif;`;
    const t = document.createElement('div');
    t.style.cssText = `font-weight:700;color:${cor};margin-bottom:4px;`;
    t.textContent = titulo;
    caixa.append(t);
    for (const l of linhas) {
        const d = document.createElement('div');
        d.textContent = l;
        caixa.append(d);
    }
    const fechar = document.createElement('button');
    fechar.type = 'button';
    fechar.textContent = '×';
    fechar.title = 'Fechar aviso';
    fechar.style.cssText = 'position:absolute;top:6px;right:8px;border:0;background:none;font-size:20px;cursor:pointer;color:#555;';
    fechar.onclick = () => caixa.remove();
    caixa.append(fechar);
    document.body.append(caixa);
}

async function preencherAbordagemNaAmigo() {
    const token = location.hash.slice(PREFIXO_PREENCHER.length);
    if (!/^[0-9a-f-]{36}$/i.test(token)) return;
    history.replaceState(null, '', location.pathname + location.search); // tira o token da barra de endereço
    let tarefa;
    try {
        tarefa = await enviarMensagem({ action: 'preencherTarefa', token });
    } catch (e) {
        return avisoNaAmigo('erro', 'Assistente de Diagnóstico: não foi possível preencher', [e.message]);
    }
    const id = (location.pathname.match(/\/connection\/(\d+)\/(?:view|edit)$/) || [])[1];
    if (!id || id !== String(tarefa.idConexao)) {
        return avisoNaAmigo('erro', 'Assistente de Diagnóstico: página diferente da esperada', ['Nada foi preenchido.']);
    }
    // Tempos medidos em 26/11/2026 (/view): a página carrega em ~1,4 s e busca o formulário depois (chega
    // em ~1,7 s; campos prontos em ~2 s). Com Splitter, a página ainda consulta portas/ofertas (~4 s), mas
    // isso não mexeu no ID ONU. Preenche assim que o formulário chega e vigia os campos por 10 s (abaixo).
    const form = await esperarAte(() =>
        [...document.forms].find(f => f.querySelector(`[name="${CAMPOS_ABORDAGEM.onuId.nomes[0]}"]`)), 20000, 100);
    if (!form) return avisoNaAmigo('erro', 'Assistente de Diagnóstico: o formulário da Amigo não carregou', ['Nada foi preenchido.']);
    await esperarMs(300); // scripts do formulário (select2, validação) terminarem de montar

    const feitos = [], pulados = [], destacar = [], vigiar = [];
    for (const [chave, valorBruto] of Object.entries(tarefa.preencher || {})) {
        const def = CAMPOS_ABORDAGEM[chave];
        const valor = String(valorBruto || '').trim();
        if (!def || !valor) continue;
        const campos = def.nomes.map(n => form.querySelector(`input[name="${n}"]`)).filter(Boolean);
        if (!campos.length) { pulados.push(`${def.rotulo}: campo não encontrado na página.`); continue; }
        // Redundância: nunca sobrescreve o que já está na Amigo.
        const existente = campos.map(c => c.value.trim()).find(Boolean);
        if (existente) { pulados.push(`${def.rotulo}: já preenchido na Amigo ("${existente.slice(0, 40)}"), não alterado.`); continue; }
        for (const c of campos) digitarNoCampo(c, valor);
        if (campos.some(c => c.value.trim().toUpperCase() !== valor.toUpperCase())) {
            pulados.push(`${def.rotulo}: a página não aceitou o valor ${valor}. Digite manualmente.`);
            continue;
        }
        feitos.push(`${def.rotulo}: ${valor}`);
        destacar.push(...campos.filter(c => c.offsetParent !== null));
        vigiar.push(...campos.map(c => ({ c, valor })));
        // Digitação real do atendente (isTrusted) desliga a vigia daquele campo.
        for (const c of campos) c.addEventListener('input', e => { if (e.isTrusted) c.dataset.zxEditado = '1'; });
    }

    for (const c of destacar) {
        c.style.outline = '3px solid #f59e0b';
        c.style.outlineOffset = '1px';
        c.style.background = '#fff7d6';
    }
    if (destacar[0]) destacar[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (feitos.length) {
        avisoNaAmigo('ok', 'Assistente de Diagnóstico: campos preenchidos com os dados do AutoISP — NADA FOI SALVO AINDA', [
            ...feitos, ...pulados, 'Confira os campos destacados em amarelo e clique em SALVAR.'
        ]);
    } else {
        avisoNaAmigo('erro', 'Assistente de Diagnóstico: nenhum campo foi preenchido', pulados.length ? pulados : ['Nada a preencher.']);
    }

    // Redundância: a montagem do formulário pela própria página APAGA o "ID ONU" visível ~2 s depois de
    // ele aparecer (medido em 26/11/2026; o valor some e não volta). Por 15 s, qualquer campo preenchido pela
    // extensão que for limpo ou trocado pela página recebe de novo o valor do AutoISP (verificação a cada
    // 0,25 s). Campo com foco ou já digitado pelo atendente nunca é tocado.
    const fimVigia = Date.now() + 15000;
    while (vigiar.length && Date.now() < fimVigia) {
        await esperarMs(250);
        for (const v of vigiar) {
            if (document.activeElement === v.c || !v.c.isConnected) continue;
            if (v.c.value.trim().toUpperCase() !== v.valor.toUpperCase() && !v.atendente) {
                if (v.c.dataset.zxEditado) { v.atendente = true; continue; }
                digitarNoCampo(v.c, v.valor);
            }
        }
    }
}

// ==========================================
// 7. AUTOISP: REDUNDÂNCIA NA BUSCA (PPPoE → ERP ID) (igual à v4.1)
// ==========================================

/**
 * Na busca do AutoISP por PPPoE (client_search?...&pppoe_username=ETIQUETA): se a página mostrar
 * "Nenhum resultado encontrado", refaz a busca pelo ERP ID com a mesma etiqueta.
 * A busca por ERP ID não tem pppoe_username, então este código não roda de novo (sem laço).
 */
function redundanciaBuscaAutoISP() {
    const params = new URLSearchParams(location.search);
    const etiqueta = (params.get('pppoe_username') || '').trim();
    if (!etiqueta || !ETIQUETA_VALIDA.test(etiqueta)) return;

    const INTERVALO_MS = 400;
    const LIMITE_MS = 20000; // o AutoISP carrega os resultados depois da página: espera até 20s
    const inicio = Date.now();

    const checar = setInterval(() => {
        const texto = document.body ? document.body.innerText : '';
        const semResultado = /Nenhum resultado encontrado/i.test(texto); // innerText ignora elementos ocultos
        const temResultado = /Exibindo \d+ registro/i.test(texto);

        if (temResultado || Date.now() - inicio > LIMITE_MS) {
            clearInterval(checar);
            return;
        }
        if (!semResultado) return;

        clearInterval(checar);
        // Aviso rápido para o atendente entender a troca de busca.
        const aviso = document.createElement('div');
        aviso.textContent = `Nada encontrado pelo PPPoE. Buscando "${etiqueta}" pelo ERP ID…`;
        aviso.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483000;' +
            'background:#17324D;color:#fff;padding:10px 16px;border-radius:6px;font:600 13px Arial,sans-serif;' +
            'box-shadow:0 6px 20px rgba(0,0,0,.25);';
        document.body.appendChild(aviso);

        params.delete('pppoe_username');
        params.set('erp_id', etiqueta);
        setTimeout(() => location.replace(`${location.pathname}?${params.toString()}`), 900);
    }, INTERVALO_MS);
}

/** Debounce simples (usado só na página da Amigo, que muda pouco). */
function debounce(fn, ms) {
    let timer;
    return () => {
        clearTimeout(timer);
        timer = setTimeout(fn, ms);
    };
}

// ==========================================
// 8. INICIALIZAÇÃO
// ==========================================

if (location.hostname.endsWith('.zendesk.com')) {
    limparChaveAntiga();
    new MutationObserver(aoMudarDom).observe(document.body, { childList: true, subtree: true });
    // Troca de aba de ticket nem sempre adiciona/remove nós: acompanha a URL (custo desprezível).
    // atualizarAtivos é barato (só compara números de ticket); o trabalho pesado fica para o momento ocioso.
    let ultimaUrl = location.href;
    setInterval(() => {
        if (location.href === ultimaUrl) return;
        ultimaUrl = location.href;
        atualizarAtivos();
        agendarVarredura();
    }, 400);
    agendarVarredura();
} else if (location.hostname === 'plataforma.sejaamigo.com.br') {
    if (location.hash.startsWith(PREFIXO_PREENCHER)) preencherAbordagemNaAmigo();
    const rodar = debounce(injetarBotaoAmigo, 250);
    new MutationObserver(rodar).observe(document.body, { childList: true, subtree: true });
    rodar();
} else if (location.hostname === 'autoisp.brasiltecpar.com.br' && location.pathname.startsWith('/client_search')) {
    redundanciaBuscaAutoISP();
} else if (location.hostname === 'autoisp.brasiltecpar.com.br' && /^\/contracted_services\/\d+$/.test(location.pathname)
    && location.hash.startsWith(PREFIXO_PRINT)) {
    capturarPrintAutoIsp();
}
