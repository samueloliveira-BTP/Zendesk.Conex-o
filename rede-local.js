/**
 * Janela "Ativar teste de portas" (aberta pelo service worker a pedido do painel do Zendesk).
 *
 * O Chrome 158+ pode exigir a permissão "Acesso à rede local" para a extensão acessar o roteador do cliente
 * (IP 100.x); o aviso só aparece numa página com interface, não no service worker. Esta página faz UM acesso
 * ao IP do cliente (porta 80) para o Chrome pedir a permissão e mostra um diagnóstico do resultado
 * (página × service worker), para sabermos onde o acesso funciona. Nada da página do roteador é lido.
 */
'use strict';

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const msg = document.getElementById('msg');
const diag = document.getElementById('diag');

function mostrar(classe, texto) {
    msg.className = classe;
    msg.textContent = texto;
}

function linhaDiag(texto) {
    const li = document.createElement('li');
    li.textContent = texto;
    diag.append(li);
}

async function estadoPermissao() {
    try { return (await navigator.permissions.query({ name: 'local-network-access' })).state; } catch (e) { return 'indisponivel'; }
}

/** Um acesso à porta 80 a partir desta página; devolve "OK (…)" ou o erro do Chrome. */
async function acessar(url, opcoes, tempoMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), tempoMs);
    const t0 = Date.now();
    try {
        const r = await fetch(url, { mode: 'no-cors', credentials: 'omit', cache: 'no-store', signal: ctrl.signal, ...opcoes });
        return { ok: true, texto: `OK (resposta ${r.type}, ${Date.now() - t0} ms)` };
    } catch (e) {
        return { ok: false, texto: ctrl.signal.aborted ? `sem resposta em ${Date.now() - t0} ms` : `erro em ${Date.now() - t0} ms: ${String(e && e.message || e).slice(0, 160)}` };
    } finally {
        clearTimeout(timer);
    }
}

(async () => {
    const ip = new URLSearchParams(location.search).get('ip') || '';
    if (!IPV4.test(ip)) return mostrar('erro', 'IP inválido. Feche esta janela e tente pelo painel do Zendesk.');
    const url = `http://${ip}/`;
    linhaDiag(`Permissão "rede local" antes: ${await estadoPermissao()}`);

    // 1) Acesso desta página (com o pedido explícito de rede local: o Chrome pode mostrar o aviso agora).
    const pagina = await acessar(url, { targetAddressSpace: 'local' }, 90000);
    linhaDiag(`Página da extensão → ${url}: ${pagina.texto}`);
    const depois = await estadoPermissao();
    linhaDiag(`Permissão "rede local" depois: ${depois}`);

    // 2) O mesmo acesso pelo service worker (onde roda o teste de portas dos tickets).
    let sw = null;
    try {
        sw = (await chrome.runtime.sendMessage({ action: 'diagnosticoPorta80', ip })).data;
        linhaDiag(`Service worker → ${url}: ${sw.estado}${sw.ms !== undefined ? ` em ${sw.ms} ms` : ''}${sw.erro ? ` — ${sw.erro}` : ''}`);
    } catch (e) {
        linhaDiag(`Service worker: não respondeu (${String(e && e.message || e).slice(0, 120)})`);
    }

    const swOk = sw && sw.estado === 'aberta';
    if (swOk) {
        mostrar('ok', 'Pronto! O teste de portas funciona. Esta janela vai fechar.');
        try { await chrome.runtime.sendMessage({ action: 'redeLocalAtivada' }); } catch (e) { /* painel confere sozinho */ }
        setTimeout(() => window.close(), 2500);
    } else if (pagina.ok) {
        mostrar('erro', 'A página da extensão alcança o roteador, mas o teste em segundo plano não. Mande um print desta janela.');
    } else if (depois === 'denied') {
        mostrar('erro', 'O acesso à rede local foi bloqueado. Mande um print desta janela.');
    } else {
        mostrar('erro', 'Não foi possível alcançar o roteador. Mande um print desta janela.');
    }
})();
