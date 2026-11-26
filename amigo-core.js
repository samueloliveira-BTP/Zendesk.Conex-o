/**
 * Assistente de Diagnóstico Zendesk — núcleo da integração com a Plataforma Amigo (v5.1)
 *
 * Código puro (não usa chrome.*): é carregado pelo service worker (importScripts) e pelos testes
 * automatizados em Node (tests/amigo-core.test.js). Toda a leitura e interpretação das respostas
 * da Amigo acontece AQUI, fora da página do Zendesk — o Zendesk só recebe um objeto pequeno e pronto.
 *
 * Fatos da Amigo que guiam este código (medidos na plataforma em 09/10/2026):
 *  - A Amigo atende UMA requisição por vez por sessão: pedidos simultâneos entram em fila no servidor
 *    (8 pedidos paralelos levaram de 0,7 s a 5,8 s). Por isso aqui existe uma fila única, com prioridade.
 *  - STATUS DA CONEXÃO: é o mesmo da aba "Conectividade" da Amigo — POST /connection-status/connection
 *    com pppoeUsername → {userfound, acctstarttime, acctupdatetime, acctstoptime} (RADIUS).
 *    Online ⇔ sessão sem acctstoptime (regra da própria Amigo). Usuário sem registro no RADIUS → HTTP 500
 *    com "Not Found" na mensagem. O uptime do equipamento NÃO é usado (vinha 00:00:00 com cliente online).
 *  - /pt/network-documentation/connection/json (POST, filtros) devolve {data:[...], recordsTotal}; cada linha
 *    já traz o usuário PPPoE e o ID do splitter (fkNetworkDocumentationCtoId), slot e porta.
 *  - /cpe-customer-info  → JSON {user (usuário PPPoE), status (contrato: Normal/Bloqueado), statusOlt, massive:[{id}]}
 *  - /cpe-equipment-info → JSON {currentIp, macAddress, model, firmware, upload/downloadLimit, ...}
 *  - /pt/autocompletefield/select2ajax (POST) é a busca de splitters (CTO) usada pela própria Amigo.
 *  - O nome do splitter aparece na página /edit como new Option('NOME', '<idCTO>', ...).
 */
'use strict';

(function (escopo) {
    const AMIGO_ORIGEM = 'https://plataforma.sejaamigo.com.br';
    // Só estes caminhos podem ser buscados (impede usar a extensão como proxy aberto).
    // /datatables/default: listagem (só leitura) dos Ativos de Rede, usada para o IP do uPE (OLT).
    const CAMINHO_PERMITIDO = /^\/(?:pt\/(?:network-documentation\/[A-Za-z0-9/_-]+|autocompletefield\/select2ajax)|datatables\/default)$/;
    const ETIQUETA_VALIDA = /^[A-Za-z0-9._:@/-]{1,64}$/;
    const USUARIO_VALIDO = /^[A-Za-z0-9._:@+-]{1,100}$/;
    const BUSCA_SPLITTER_VALIDA = /^[\p{L}\p{N} ._\-/[\]()#]{2,60}$/u;
    // Base64 de "App\Entity\Panel\NetworkDocumentation\Cto": a entidade que o filtro "Splitter" da Amigo pesquisa.
    const ENTIDADE_CTO = 'QXBwXEVudGl0eVxQYW5lbFxOZXR3b3JrRG9jdW1lbnRhdGlvblxDdG8=';

    const TEMPO = {
        pagina: 25000,      // páginas/JSON de uma conexão
        lista: 40000,       // busca de conexões (≈4 s normalmente)
        buscaCto: 45000,    // autocomplete de splitters (≈18 s medido)
        novaTentativa: 1000 // espera antes de repetir uma consulta de status que falhou
    };
    const CACHE_CLIENTE_MS = 2 * 60 * 1000;
    const CACHE_SPLITTER_MS = 24 * 3600 * 1000;
    const CACHE_EDICAO_MS = 30 * 1000;
    const CACHE_IP_OLT_MS = 6 * 3600 * 1000; // IP de OLT quase nunca muda
    const IPV4_VALIDO = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
    const NOME_ATIVO_VALIDO = /^[A-Za-z0-9._ -]{2,80}$/;

    /** Erro com código, para a interface decidir o que mostrar (ex.: link de login). */
    class ErroAmigo extends Error {
        constructor(mensagem, codigo, corpo) {
            super(mensagem);
            this.codigo = codigo || 'ERRO';
            this.corpo = corpo || ''; // corpo da resposta de erro (uso interno, nunca exibido)
        }
    }

    // ==========================================
    // Texto
    // ==========================================

    const ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    // Acentos nomeados (&atilde;, &Ccedil;...): letra + acento combinante, normalizado.
    const ACENTOS = { acute: '́', grave: '̀', circ: '̂', tilde: '̃', cedil: '̧', uml: '̈' };

    function decodificarEntidades(s) {
        return String(s).replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e) => {
            if (e[0] === '#') {
                const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
                return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
            }
            const acento = /^([a-z])(acute|grave|circ|tilde|cedil|uml)$/i.exec(e);
            if (acento) return (acento[1] + ACENTOS[acento[2].toLowerCase()]).normalize('NFC');
            const v = ENTIDADES[e.toLowerCase()];
            return v === undefined ? m : v;
        });
    }

    /** Texto limpo e curto: sem tags, entidades decodificadas, espaços normalizados. Nunca devolve HTML. */
    function textoLimpo(v, max = 200) {
        if (v === null || v === undefined) return '';
        return decodificarEntidades(String(v).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, max);
    }

    const somenteDigitos = v => {
        const s = String(v === null || v === undefined ? '' : v).trim();
        return /^\d{1,12}$/.test(s) ? s : null;
    };

    // ==========================================
    // Interpretação das respostas
    // ==========================================

    function parseJson(texto, oQue) {
        try {
            return JSON.parse(texto);
        } catch (e) {
            throw new ErroAmigo(`Resposta inesperada da Amigo (${oQue}).`, 'FORMATO');
        }
    }

    const linhasDaLista = json => {
        const lista = json && (json.data || json.items || json.rows);
        return Array.isArray(lista) ? lista.filter(i => i && typeof i === 'object' && !Array.isArray(i)) : [];
    };

    /** Linha da lista de conexões reduzida ao que a interface usa. */
    function resumirLinha(i) {
        return {
            id: somenteDigitos(i.id),
            nome: textoLimpo(i.personName, 120),
            etiqueta: textoLimpo(i.serviceTag, 64),
            usuarioPppoe: textoLimpo(i.userPPPoE, 100),
            usuarioIpoe: textoLimpo(i.userIpoe, 100),
            plano: textoLimpo(i.offerName, 120),
            tipo: textoLimpo(i.connectionType, 60),
            contrato: textoLimpo(i.status, 40),
            ativo: typeof i.enabled === 'boolean' ? i.enabled : null,
            ctoId: somenteDigitos(i.fkNetworkDocumentationCtoId),
            slot: somenteDigitos(i.slot),
            porta: somenteDigitos(i.portNumber),
            concentrador: textoLimpo(i.fkNetworkDocumentationActiveIdCeName, 80),
            pontoAcesso: textoLimpo(i.fkNetworkDocumentationActivesIdApName, 80),
            onuSn: textoLimpo(i.onuSn, 40)
        };
    }

    const chave = s => textoLimpo(s, 120).toLowerCase().replace(/\s+/g, '');

    /**
     * Escolhe a conexão cuja etiqueta (ou usuário PPPoE/IPoE) é EXATAMENTE o termo — a busca da Amigo
     * é "contém", então "ABC123" também traz "ABC1234". Empates: etiqueta antes de usuário, conexão ativa,
     * contrato Normal e, por fim, a mais recente (maior ID).
     */
    function escolherConexao(lista, termo) {
        const alvo = chave(termo);
        const pontuar = i => {
            const porEtiqueta = chave(i.serviceTag) === alvo;
            const porUsuario = [i.userPPPoE, i.userIpoe].some(v => v && chave(v) === alvo);
            if (!porEtiqueta && !porUsuario) return null;
            return (porEtiqueta ? 8 : 0) + (i.enabled === true ? 4 : 0) + (/^normal$/i.test(textoLimpo(i.status)) ? 2 : 0);
        };
        const exatos = lista
            .map(i => ({ i, p: pontuar(i) }))
            .filter(x => x.p !== null && somenteDigitos(x.i.id))
            .sort((a, b) => (b.p - a.p) || (Number(b.i.id) - Number(a.i.id)));
        return { escolhida: exatos.length ? exatos[0].i : null, exatos: exatos.length, total: lista.length };
    }

    /**
     * "Status da Conexão" da Amigo (RADIUS). Mesma regra da tela Conectividade:
     * Online ⇔ a sessão não tem acctstoptime.
     */
    function interpretarStatusRadius(j) {
        if (!j || typeof j !== 'object' || Array.isArray(j)) throw new ErroAmigo('Resposta inesperada da Amigo (status da conexão).', 'FORMATO');
        const inicio = textoLimpo(j.acctstarttime, 30);
        const atualizacao = textoLimpo(j.acctupdatetime, 30);
        const fim = textoLimpo(j.acctstoptime, 30);
        const sessao = { inicio, atualizacao, fim };
        if (j.userfound === false) {
            return { estado: 'offline', motivo: 'Usuário sem sessão registrada no RADIUS.', ...sessao };
        }
        if (!fim) {
            return { estado: 'online', motivo: `Status da Conexão na Amigo: Online${inicio ? ` (sessão desde ${inicio})` : ''}.`, ...sessao };
        }
        return { estado: 'offline', motivo: `Status da Conexão na Amigo: Offline (sessão encerrada em ${fim}).`, ...sessao };
    }

    /** Erro da consulta de status que significa "o RADIUS não tem este usuário" (a Amigo devolve HTTP 500 + Not Found). */
    const ehSemRegistroRadius = e => e && e.codigo === 'HTTP' && /not\s*found/i.test(e.corpo || '');

    /** Nome do splitter na página /edit da conexão, procurado pelo ID exato do CTO. */
    function nomeSplitterDaEdicao(html, ctoId) {
        const id = somenteDigitos(ctoId);
        if (!id || !html) return null;
        const texto = String(html);
        // 1) Padrão do select2: new Option('NOME', '<id>', ...)
        const reOption = new RegExp(`new\\s+Option\\(\\s*(['"])((?:\\\\.|(?!\\1)[^\\\\\\n]){1,200})\\1\\s*,\\s*(['"])${id}\\3`);
        const m = texto.match(reOption);
        if (m) return textoLimpo(m[2].replace(/\\(.)/g, '$1'), 120) || null;
        // 2) Plano B: <option value="<id>">NOME</option> dentro do select do CTO.
        const i = texto.search(/fkNetworkDocumentationCtoId/);
        if (i >= 0) {
            const trecho = texto.slice(i, i + 20000);
            const m2 = trecho.match(new RegExp(`<option[^>]*value=["']${id}["'][^>]*>([^<]{1,200})<`, 'i'));
            if (m2) return textoLimpo(m2[1], 120) || null;
        }
        return null;
    }

    // ==========================================
    // Abordagem da conexão: Amigo × AutoISP
    // ==========================================
    //
    // Medido em 06/11/2026 (só leitura, sessão do atendente):
    //  - A aba "Abordagem" faz parte do formulário único de /connection/{id}/edit (POST normal, botão #edit,
    //    validação jQuery). São ~91 campos, inclusive senhas: o salvamento NUNCA é montado aqui — ele usa a
    //    própria página da Amigo (content.js), como um atendente faria, e depois é conferido por releitura.
    //  - Tecnologia (select technologyType) nunca fica vazia: não há opção em branco (3 = FTTH). Só conferimos.
    //  - Slot/Porta OLT: com Splitter (CTO) a página os tira da CTO. Sem CTO há os campos de texto
    //    connection[slotOltFake]/[portOltFake], que GRAVAM (teste com salvamento real em 26/11/2026), mas o valor
    //    não vem no HTML: a página o põe por script ($('#connection_slotOltFake').val('4')).
    //  - ID ONU (onuId) e, sem CTO, Slot/Porta OLT podem ser preenchidos. O Serial (onuSn) ficou fora da
    //    extensão a pedido do usuário (26/11/2026): não é conferido, exibido nem preenchido.
    //  - PON do AutoISP "a/b/c" = Slot b, Porta c (conferido em 3 de 3 conexões completas).

    const campoAbordagem = n => `connectionApproach[0][${n}]`;
    const escRegex = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    function atributo(tag, nome) {
        const m = new RegExp(`\\s${nome}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
        return m ? decodificarEntidades(m[1] !== undefined ? m[1] : m[2]) : null;
    }

    function tagDoCampo(html, tag, nome) {
        const m = new RegExp(`<${tag}\\b[^>]*\\sname\\s*=\\s*["']${escRegex(nome)}["'][^>]*>`, 'i').exec(html);
        return m ? { tag: m[0], fim: m.index + m[0].length } : null;
    }

    /** Valor de um <input name="..."> no HTML; null se o campo não existe. */
    function valorInput(html, nome) {
        const t = tagDoCampo(html, 'input', nome);
        return t ? textoLimpo(atributo(t.tag, 'value') || '', 100) : null;
    }

    /** Opções de um <select name="..."> no HTML ([{valor, texto, selecionada}]); null se não existe. */
    function opcoesSelect(html, nome) {
        const t = tagDoCampo(html, 'select', nome);
        if (!t) return null;
        const fim = html.indexOf('</select>', t.fim);
        const bloco = html.slice(t.fim, fim < 0 ? t.fim + 20000 : fim);
        return [...bloco.matchAll(/<option\b([^>]*)>([^<]*)/gi)].map(m => ({
            valor: textoLimpo(atributo(m[1], 'value') || '', 40),
            texto: textoLimpo(m[2], 80),
            selecionada: /\sselected\b/i.test(m[1])
        }));
    }

    /**
     * Abordagem gravada na Amigo, lida do HTML de /edit. `controle` guarda campos-chave só para conferir,
     * depois de salvar, que nada além do pedido mudou (fica no service worker; não vai para o Zendesk).
     */
    function lerAbordagemDaEdicao(html) {
        const texto = String(html || '');
        const tecnologias = opcoesSelect(texto, campoAbordagem('technologyType'));
        const onuId = valorInput(texto, campoAbordagem('onuId'));
        const onuSn = valorInput(texto, campoAbordagem('onuSn'));
        if (!tecnologias || !tecnologias.length || onuId === null || onuSn === null) {
            throw new ErroAmigo('Não foi possível ler a Abordagem na página da Amigo (a página mudou?).', 'FORMATO');
        }
        // Sem "selected" o navegador mostra a primeira opção: é o que está gravado.
        const tec = tecnologias.find(o => o.selecionada) || tecnologias[0];
        // Sem Splitter, Slot/Porta OLT ficam nos campos "fake" e a Amigo NÃO os põe no value do HTML: ela os
        // preenche por script — $('#connection_slotOltFake').val('4') (medido em 26/11/2026). Vale o último
        // valor não vazio do script (antes vêm os .val('') de limpeza).
        const porScript = id => {
            let v = '';
            for (const m of texto.matchAll(new RegExp(`#connection_${id}['"]\\)\\.val\\(\\s*['"]([^'"]{1,10})['"]\\s*\\)`, 'g'))) v = m[1];
            return somenteDigitos(v) || '';
        };
        return {
            tecnologia: { valor: tec.valor, texto: tec.texto },
            onuId,
            onuSn,
            slot: porScript('slotOltFake'),
            porta: porScript('portOltFake'),
            controle: {
                etiqueta: valorInput(texto, 'connection[serviceTag]') || '',
                usuarioPppoe: valorInput(texto, campoAbordagem('userPPPoE')) || '',
                vlan: valorInput(texto, campoAbordagem('vlan')) || '',
                tecnologia: tec.valor,
                // IDs dos itens pré-selecionados pelo select2 (Ponto de acesso, Concentrador, Splitter...).
                selecionados: [...texto.matchAll(/new\s+Option\(\s*'(?:\\.|[^'\\]){0,200}'\s*,\s*'?(\d{1,12})'?/g)].map(m => m[1]).join(',')
            }
        };
    }

    /** Serial GPON comparável: "485754430FBB1630" (hex) e "HWTC0FBB1630" viram o mesmo texto. */
    function normalizarSerial(s) {
        const t = String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
        if (/^[0-9A-F]{16}$/.test(t)) {
            const prefixo = t.slice(0, 8).match(/../g).map(x => String.fromCharCode(parseInt(x, 16))).join('');
            if (/^[A-Z]{4}$/.test(prefixo)) return prefixo + t.slice(8);
        }
        return t;
    }

    /** Slot e porta da OLT a partir do PON do AutoISP: "1/1/7" → slot 1, porta 7; "2/5" → slot 2, porta 5. */
    function slotPortaDoPon(ponlink) {
        const p = String(ponlink || '').split('/').map(x => x.trim());
        if (!p.every(x => /^\d{1,3}$/.test(x))) return null;
        if (p.length === 3) return { slot: String(Number(p[1])), porta: String(Number(p[2])) };
        if (p.length === 2) return { slot: String(Number(p[0])), porta: String(Number(p[1])) };
        return null;
    }

    const ID_ONU_VALIDO = /^\d{1,4}$/;

    /**
     * Confere a Abordagem da Amigo com o AutoISP. Estados de cada item:
     *  ok (igual ao AutoISP) | preenchido (a Amigo tem, o AutoISP não tem para conferir)
     *  | faltando (vazio na Amigo, o AutoISP tem: pode preencher) | divergente (os dois têm e diferem: só avisa)
     *  | depende-splitter (slot/porta vazios: só a CTO grava) | sem-dado (nenhum dos dois tem).
     * `preencher` só tem campos VAZIOS na Amigo com valor válido no AutoISP — nada já preenchido é trocado.
     */
    function compararAbordagem(ab, conexao, onu) {
        const c = conexao || {}, o = onu || {};
        const temOnu = !!(o.serial || o.ponlink || o.olt);
        const pon = slotPortaDoPon(o.ponlink);
        const itens = [];
        const preencher = {};
        const add = (campo, rotulo, amigo, autoisp, estado) => itens.push({ campo, rotulo, amigo: amigo || '', autoisp: autoisp || '', estado });

        const ftth = /^ftth$/i.test(ab.tecnologia.texto);
        add('tecnologia', 'Tecnologia', ab.tecnologia.texto, temOnu ? 'FTTH' : '',
            ftth ? 'ok' : (temOnu ? 'divergente' : 'sem-dado'));

        // Slot/Porta: com Splitter vêm da CTO (lista de conexões); sem Splitter, dos campos de texto da edição
        // (gravam — teste com salvamento real em 26/11/2026). Sem Splitter e vazio: preenchível pelo PON Link.
        for (const [campo, rotulo, valor] of [['slot', 'Slot OLT', c.slot || ab.slot], ['porta', 'Porta OLT', c.porta || ab.porta]]) {
            const ref = pon ? pon[campo] : '';
            let estado;
            if (!valor) {
                if (!c.ctoId && ref) { estado = 'faltando'; preencher[campo] = ref; }
                else estado = c.ctoId && !ref ? 'sem-dado' : (c.ctoId ? 'depende-splitter' : 'sem-dado');
            } else if (!ref) estado = 'preenchido';
            else estado = String(Number(valor)) === ref ? 'ok' : 'divergente';
            add(campo, rotulo, valor, ref, estado);
        }

        const idAutoIsp = ID_ONU_VALIDO.test(String(o.onuId || '')) ? String(Number(o.onuId)) : '';
        if (ab.onuId) add('onuId', 'ID ONU', ab.onuId, idAutoIsp, !idAutoIsp ? 'preenchido' : (String(Number(ab.onuId)) === idAutoIsp ? 'ok' : 'divergente'));
        else if (idAutoIsp) { add('onuId', 'ID ONU', '', idAutoIsp, 'faltando'); preencher.onuId = idAutoIsp; }
        else add('onuId', 'ID ONU', '', '', 'sem-dado');

        // Serial: fora da conferência e do preenchimento (pedido do usuário em 26/11/2026 — "pode prejudicar").

        const conta = e => itens.filter(i => i.estado === e).length;
        return {
            itens,
            preencher,
            totalPreencher: Object.keys(preencher).length,
            divergentes: conta('divergente'),
            completo: itens.every(i => i.estado === 'ok' || i.estado === 'preenchido'),
            temOnu
        };
    }

    /** Resultado do autocomplete de splitters: [{id, nome}] sem repetidos. */
    function resumirBuscaSplitter(json) {
        const arr = Array.isArray(json) ? json : (json && (json.results || json.items || json.data)) || [];
        const vistos = new Set();
        const itens = [];
        for (const x of arr) {
            const id = x && somenteDigitos(x.id);
            if (!id || vistos.has(id)) continue;
            vistos.add(id);
            itens.push({ id, nome: textoLimpo(x.name ?? x.text, 120) || `Splitter ${id}` });
        }
        return itens;
    }

    function formatarLimite(eq) {
        const v = x => (x === null || x === undefined || x === '' || String(x) === '0') ? null : textoLimpo(x, 20);
        const down = v(eq && eq.downloadLimit), up = v(eq && eq.uploadLimit);
        return down || up ? `↓ ${down || '—'}  ·  ↑ ${up || '—'}` : '';
    }

    // ==========================================
    // Cliente HTTP da Amigo (fila única com prioridade)
    // ==========================================

    /**
     * fetchFn: fetch (injetável nos testes). esperar: ms → Promise. agora: () → ms.
     */
    // ---------- IP da OLT (= Ponto de acesso / uPE na Amigo) ----------

    /**
     * Parâmetros da tabela "Ativos de Rede" da Amigo, lidos da própria página (/pt/network-documentation/actives):
     * no bloco "ajax" do DataTables, d.columns = "…"; d.entity = "…"; … (valores base64 que descrevem as colunas).
     * Ler da página evita fixar valores internos que podem mudar.
     */
    function parametrosTabelaAtivos(html) {
        const texto = String(html || '');
        const i = texto.indexOf('"ajax"');
        if (i < 0) throw new ErroAmigo('Formato inesperado da página de Ativos da Amigo.', 'FORMATO');
        const bloco = texto.slice(i, i + 6000);
        const params = {};
        for (const m of bloco.matchAll(/d\.(\w{2,40})\s*=\s*"([A-Za-z0-9+/=_ -]{1,4000})"\s*;/g)) {
            if (!(m[1] in params)) params[m[1]] = m[2];
        }
        for (const k of ['columns', 'entity', 'route']) {
            if (!params[k]) throw new ErroAmigo('Formato inesperado da página de Ativos da Amigo.', 'FORMATO');
        }
        return params;
    }

    /** Linha do ativo com o nome EXATO (a busca é "contém") → {ip, id, funcao, categoria}; null se não houver. */
    function ipDaTabelaAtivos(json, nome) {
        const alvo = textoLimpo(nome, 80).toLowerCase();
        const linhas = json && Array.isArray(json.data) ? json.data : [];
        for (const r of linhas) {
            if (!Array.isArray(r) || r.length < 7) continue;
            if (textoLimpo(r[3], 80).toLowerCase() !== alvo) continue;
            const ip = textoLimpo(r[6], 45);
            if (!IPV4_VALIDO.test(ip)) continue;
            return { ip, id: somenteDigitos(r[1]), funcao: textoLimpo(r[4], 40), categoria: textoLimpo(r[5], 40) };
        }
        return null;
    }

    /** OLT da lista do AutoISP (/olts/olts_list) → {ip, hostname, modelo}; null se não houver. */
    function ipDaListaOlts(json, oltId) {
        const id = somenteDigitos(oltId);
        const lista = json && Array.isArray(json.olts) ? json.olts : [];
        const o = lista.find(x => x && String(x.id) === id);
        if (!o) return null;
        const ip = textoLimpo(o.ip, 45);
        if (!IPV4_VALIDO.test(ip)) return null;
        return { ip, hostname: textoLimpo(o.hostname, 80), modelo: textoLimpo(o.model, 60) };
    }

    function criarClienteAmigo({ fetchFn, esperar = ms => new Promise(r => setTimeout(r, ms)), agora = () => Date.now(), tempos = {} } = {}) {
        const T = { ...TEMPO, ...tempos };
        const fila = { alta: [], baixa: [] };
        let ocupado = false;
        const emAndamento = new Map();
        const cacheClientes = new Map();
        const consultasClientes = new Map();
        const cacheSplitters = new Map();

        /** Uma requisição por vez: a Amigo serializa por sessão, então paralelismo só gera fila e timeout. */
        function agendar(tarefa, prioridade) {
            return new Promise((resolve, reject) => {
                fila[prioridade === 'baixa' ? 'baixa' : 'alta'].push({ tarefa, resolve, reject });
                bombear();
            });
        }

        async function bombear() {
            if (ocupado) return;
            const item = fila.alta.shift() || fila.baixa.shift();
            if (!item) return;
            ocupado = true;
            try {
                item.resolve(await item.tarefa());
            } catch (e) {
                item.reject(e);
            } finally {
                ocupado = false;
                bombear();
            }
        }

        async function executar(caminho, metodo, corpo, tempoMs) {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), tempoMs);
            const opcoes = { method: metodo, credentials: 'include', signal: ctrl.signal, headers: { 'X-Requested-With': 'XMLHttpRequest' } };
            if (metodo === 'POST') {
                opcoes.headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
                opcoes.body = corpo;
            }
            const erroLogin = () => new ErroAmigo('Você não está logado na Amigo. Faça login na plataforma Amigo e clique em Atualizar.', 'LOGIN_REQUIRED');
            try {
                const resp = await fetchFn(AMIGO_ORIGEM + caminho, opcoes);
                // Sem sessão, a Amigo redireciona para /login ou responde 401/403.
                let destino = '';
                try { destino = new URL(resp.url || AMIGO_ORIGEM + caminho).pathname; } catch (e) { /* URL inválida */ }
                if (/\/login\b/.test(destino) || resp.status === 401 || resp.status === 403) throw erroLogin();
                if (!resp.ok) {
                    const corpoErro = await resp.text().catch(() => '');
                    throw new ErroAmigo(`A Amigo respondeu com erro (HTTP ${resp.status}).`, 'HTTP', String(corpoErro).slice(0, 500));
                }
                const texto = await resp.text();
                // Tela de login sem redirecionamento (formulário com _csrf_token + _password).
                if (/name=["']_password["']/i.test(texto) && /name=["']_csrf_token["']/i.test(texto)) throw erroLogin();
                return texto;
            } catch (e) {
                if (e instanceof ErroAmigo) throw e;
                if (e && e.name === 'AbortError') throw new ErroAmigo('A Amigo demorou demais para responder.', 'TIMEOUT');
                throw new ErroAmigo('Falha de rede ao contatar a Amigo.', 'REDE');
            } finally {
                clearTimeout(timer);
            }
        }

        /** Requisição validada, enfileirada e deduplicada (pedidos idênticos em andamento são reaproveitados). */
        function requisitar(caminho, { metodo = 'GET', dados = null, tempo = T.pagina, prioridade = 'alta' } = {}) {
            if (!CAMINHO_PERMITIDO.test(caminho)) return Promise.reject(new ErroAmigo('Endereço da Amigo não permitido.', 'ENTRADA'));
            const corpo = dados ? new URLSearchParams(dados).toString() : null;
            const id = `${metodo} ${caminho} ${corpo || ''}`;
            if (emAndamento.has(id)) return emAndamento.get(id);
            const p = agendar(() => executar(caminho, metodo, corpo, tempo), prioridade);
            emAndamento.set(id, p);
            const limpar = () => { if (emAndamento.get(id) === p) emAndamento.delete(id); };
            p.then(limpar, limpar);
            return p;
        }

        const buscarConexoes = (filtros, { tamanho = 25, prioridade = 'alta' } = {}) =>
            requisitar('/pt/network-documentation/connection/json', {
                metodo: 'POST', tempo: T.lista, prioridade,
                dados: { ...filtros, 'pagination[pageNumber]': '1', 'pagination[pageSize]': String(tamanho) }
            }).then(t => parseJson(t, 'lista de conexões'));

        /** JSON de um objeto da Amigo; falha vira null (dado complementar), exceto falta de login. */
        async function lerObjeto(caminho, oQue, prioridade) {
            try {
                const j = parseJson(await requisitar(caminho, { prioridade }), oQue);
                return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
            } catch (e) {
                if (e.codigo === 'LOGIN_REQUIRED') throw e;
                return null;
            }
        }

        const lerContrato = (id, prioridade) => lerObjeto(`/pt/network-documentation/${id}/cpe-customer-info/connection`, 'cliente', prioridade);
        const lerEquipamento = (id, prioridade) => lerObjeto(`/pt/network-documentation/${id}/cpe-equipment-info/connection`, 'equipamento', prioridade);

        /**
         * "Status da Conexão" pelo RADIUS (a mesma consulta da aba Conectividade da Amigo).
         * Falhou → tenta mais uma vez. Falha nunca vira Offline: vira "indeterminado".
         */
        async function statusPorUsuario(usuarioBruto, prioridade = 'alta') {
            const usuario = textoLimpo(usuarioBruto, 100);
            if (!USUARIO_VALIDO.test(usuario)) {
                return { estado: 'indeterminado', motivo: 'Conexão sem usuário PPPoE cadastrado na Amigo: não há como consultar o status.', inicio: '', atualizacao: '', fim: '' };
            }
            let ultimoErro = null;
            for (let tentativa = 0; tentativa < 2; tentativa++) {
                if (tentativa) await esperar(T.novaTentativa);
                try {
                    const t = await requisitar('/pt/network-documentation/connection-status/connection', {
                        metodo: 'POST', prioridade, dados: { pppoeUsername: usuario }
                    });
                    return interpretarStatusRadius(parseJson(t, 'status da conexão'));
                } catch (e) {
                    if (e.codigo === 'LOGIN_REQUIRED') throw e;
                    if (ehSemRegistroRadius(e)) {
                        return { estado: 'offline', motivo: 'Usuário sem sessão registrada no RADIUS (a Amigo não encontrou o status).', inicio: '', atualizacao: '', fim: '' };
                    }
                    ultimoErro = e;
                }
            }
            return {
                estado: 'indeterminado',
                motivo: 'Não foi possível consultar o Status da Conexão na Amigo' + (ultimoErro && ultimoErro.message ? `: ${ultimoErro.message}` : '.'),
                inicio: '', atualizacao: '', fim: ''
            };
        }

        /** Status de uma conexão da lista (verificação em massa). Sem usuário conhecido, lê o cadastro. */
        async function statusConexao({ idConexao, usuario } = {}, { prioridade = 'alta' } = {}) {
            const id = somenteDigitos(idConexao);
            let u = textoLimpo(usuario, 100);
            if (!u) {
                if (!id) throw new ErroAmigo('Conexão inválida.', 'ENTRADA');
                const contrato = await lerContrato(id, prioridade);
                u = textoLimpo(contrato && contrato.user, 100);
            }
            return statusPorUsuario(u, prioridade);
        }

        /** Localiza a conexão pela etiqueta; se não achar, tenta como usuário PPPoE e usuário IPoE. */
        async function localizarConexao(termo) {
            let parecidos = 0;
            for (const filtro of ['serviceTag', 'userName', 'userIpoe']) {
                const lista = linhasDaLista(await buscarConexoes({ [`filters[${filtro}]`]: termo }));
                const r = escolherConexao(lista, termo);
                if (r.escolhida) return { ...r, filtro };
                if (filtro === 'serviceTag') parecidos = lista.length;
            }
            throw new ErroAmigo(parecidos
                ? `Etiqueta não encontrada exatamente na Amigo (${parecidos} resultado(s) parecido(s)). Confira a etiqueta.`
                : 'Cliente não encontrado na Amigo (busca por etiqueta, usuário PPPoE e IPoE).', 'NAO_ENCONTRADO');
        }

        async function montarDiagnostico(termo) {
            const local = await localizarConexao(termo);
            const conexao = resumirLinha(local.escolhida);
            const contrato = await lerContrato(conexao.id, 'alta');
            // Mesmo usuário que a tela Conectividade da Amigo envia (campo "user" do cliente).
            const usuario = textoLimpo(contrato && contrato.user, 100) || conexao.usuarioPppoe || conexao.usuarioIpoe;
            const status = await statusPorUsuario(usuario, 'alta');
            const eq = (await lerEquipamento(conexao.id, 'alta')) || {};
            const massivas = contrato && Array.isArray(contrato.massive) ? contrato.massive : [];
            return {
                consultadoEm: agora(),
                termo,
                filtro: local.filtro,
                correspondencias: local.exatos,
                conexao,
                usuarioRadius: usuario,
                contrato: textoLimpo(contrato && contrato.status, 40) || conexao.contrato,
                statusOlt: textoLimpo(contrato && contrato.statusOlt, 40),
                massivas: massivas.length,
                // A Amigo devolve só o ID de cada massiva ([{id}]); a página dela é /service-massive/{id}/show (a /view não abre).
                massivasIds: massivas.map(m => somenteDigitos(m && typeof m === 'object' ? m.id : m)).filter(Boolean).slice(0, 5),
                estado: status.estado,
                motivo: status.motivo,
                sessaoInicio: status.inicio,
                sessaoAtualizacao: status.atualizacao,
                sessaoFim: status.fim,
                ip: textoLimpo(eq.currentIp, 45),
                mac: textoLimpo(eq.macAddress, 40).toUpperCase(),
                limite: formatarLimite(eq),
                usuarioEquip: textoLimpo(eq.equipmentUser, 100),
                senhaEquip: eq.equipmentPassword ? String(eq.equipmentPassword).slice(0, 100) : '',
                modelo: textoLimpo(eq.model, 80),
                firmware: textoLimpo(eq.firmware, 80),
                tipoEquip: textoLimpo(eq.equipmentType, 60)
            };
        }

        /** Diagnóstico completo de uma etiqueta (cache de 2 min; forcar ignora o cache). */
        function consultarCliente(termoBruto, { forcar = false } = {}) {
            const termo = String(termoBruto || '').trim();
            if (!ETIQUETA_VALIDA.test(termo)) return Promise.reject(new ErroAmigo('Etiqueta inválida.', 'ENTRADA'));
            const k = termo.toLowerCase();
            const salvo = cacheClientes.get(k);
            if (!forcar && salvo && agora() - salvo.em < CACHE_CLIENTE_MS) return Promise.resolve({ ...salvo.valor, doCache: true });
            if (consultasClientes.has(k)) return consultasClientes.get(k); // mesma etiqueta em dois tickets: uma consulta só
            const p = montarDiagnostico(termo).then(valor => {
                // "Indeterminado" não fica em cache: a próxima abertura tenta de novo.
                if (valor.estado !== 'indeterminado') cacheClientes.set(k, { em: agora(), valor });
                if (cacheClientes.size > 300) cacheClientes.delete(cacheClientes.keys().next().value);
                return valor;
            });
            consultasClientes.set(k, p);
            const limpar = () => consultasClientes.delete(k);
            p.then(limpar, limpar);
            return p;
        }

        /**
         * HTML da página /edit da conexão (usada pelo nome do splitter e pela Abordagem). Cache curto (30 s) para
         * as duas leituras do mesmo ticket virarem uma só; forcar sempre relê (conferência antes/depois de salvar).
         */
        const cacheEdicao = new Map();
        async function lerEdicao(id, { prioridade = 'baixa', forcar = false } = {}) {
            const salvo = cacheEdicao.get(id);
            if (!forcar && salvo && agora() - salvo.em < CACHE_EDICAO_MS) return salvo.html;
            const html = await requisitar(`/pt/network-documentation/connection/${id}/edit`, { prioridade, tempo: T.pagina });
            cacheEdicao.set(id, { em: agora(), html });
            if (cacheEdicao.size > 50) cacheEdicao.delete(cacheEdicao.keys().next().value);
            return html;
        }

        /** Nome do splitter (lê a página /edit com prioridade baixa; cache por CTO). */
        async function nomeSplitter(idConexao, ctoId) {
            const id = somenteDigitos(idConexao), cto = somenteDigitos(ctoId);
            if (!id || !cto) throw new ErroAmigo('Splitter inválido.', 'ENTRADA');
            const salvo = cacheSplitters.get(cto);
            if (salvo && agora() - salvo.em < CACHE_SPLITTER_MS) return salvo.nome;
            const nome = nomeSplitterDaEdicao(await lerEdicao(id), cto);
            if (nome) cacheSplitters.set(cto, { em: agora(), nome });
            return nome;
        }

        /** Campos da Abordagem gravados na Amigo (lidos da página /edit). */
        async function abordagem(idConexao, { prioridade = 'baixa', forcar = false } = {}) {
            const id = somenteDigitos(idConexao);
            if (!id) throw new ErroAmigo('Conexão inválida.', 'ENTRADA');
            return lerAbordagemDaEdicao(await lerEdicao(id, { prioridade, forcar }));
        }

        /**
         * IP do Ponto de acesso (uPE) pelo nome, na tabela "Ativos de Rede" (prioridade baixa, cache de 6 h).
         * Os parâmetros da tabela vêm da própria página da Amigo (lidos uma vez por sessão do service worker).
         */
        let paramsAtivos = null;
        const cacheUpe = new Map();
        async function ipDoUpe(nomeBruto) {
            const nome = textoLimpo(nomeBruto, 80);
            if (!NOME_ATIVO_VALIDO.test(nome)) throw new ErroAmigo('Nome do ponto de acesso inválido.', 'ENTRADA');
            const k = nome.toLowerCase();
            const salvo = cacheUpe.get(k);
            if (salvo && agora() - salvo.em < CACHE_IP_OLT_MS) return salvo.valor;
            if (!paramsAtivos) {
                paramsAtivos = parametrosTabelaAtivos(await requisitar('/pt/network-documentation/actives', { prioridade: 'baixa' }));
            }
            const t = await requisitar('/datatables/default', {
                metodo: 'POST', prioridade: 'baixa', tempo: T.lista,
                dados: {
                    draw: '1', start: '0', length: '10', 'search[value]': nome, 'search[regex]': 'false',
                    'order[0][column]': '1', 'order[0][dir]': 'asc', ...paramsAtivos
                }
            }).catch(e => { paramsAtivos = null; throw e; }); // parâmetros podem ter mudado: relê na próxima
            const valor = ipDaTabelaAtivos(parseJson(t, 'tabela de ativos'), nome);
            cacheUpe.set(k, { em: agora(), valor });
            if (cacheUpe.size > 200) cacheUpe.delete(cacheUpe.keys().next().value);
            return valor;
        }

        /** Pesquisa de splitters pelo nome (mesma busca do filtro "Splitter" da Amigo). */
        async function buscarSplitters(termoBruto, pagina = 1) {
            const termo = String(termoBruto || '').trim().replace(/\s+/g, ' ');
            if (!BUSCA_SPLITTER_VALIDA.test(termo)) {
                throw new ErroAmigo('Digite de 2 a 60 caracteres (letras, números, espaço, ponto, hífen ou barra).', 'ENTRADA');
            }
            const pg = Math.min(Math.max(parseInt(pagina, 10) || 1, 1), 50);
            const t = await requisitar('/pt/autocompletefield/select2ajax', {
                metodo: 'POST', tempo: T.buscaCto,
                dados: { q: termo, entity: ENTIDADE_CTO, columnName: 'cmCtoName', page: String(pg) }
            });
            const json = parseJson(t, 'busca de splitter');
            const itens = resumirBuscaSplitter(json);
            for (const s of itens) cacheSplitters.set(s.id, { em: agora(), nome: s.nome });
            const bruto = Array.isArray(json) ? json.length : itens.length;
            return { termo, pagina: pg, itens, temMais: bruto >= 10 };
        }

        /** Clientes de um splitter (até 100), com situação do contrato. */
        async function clientesDoSplitter(ctoId) {
            const cto = somenteDigitos(ctoId);
            if (!cto) throw new ErroAmigo('Splitter inválido.', 'ENTRADA');
            const json = await buscarConexoes({ 'filters[splitter]': cto }, { tamanho: 100 });
            const itens = linhasDaLista(json).map(resumirLinha).filter(c => c.id);
            const total = Number(json && json.recordsTotal) || itens.length;
            return { ctoId: cto, itens, total };
        }

        return {
            consultarCliente,
            statusConexao,
            nomeSplitter,
            abordagem,
            ipDoUpe,
            buscarSplitters,
            clientesDoSplitter,
            // expostos para testes
            _requisitar: requisitar,
            _fila: () => ({ alta: fila.alta.length, baixa: fila.baixa.length, ocupado })
        };
    }

    // ==========================================
    // AutoISP (dados da ONU já coletados — sem consultar a OLT na hora)
    // ==========================================
    //
    // Medido em 11/10/2026, com a sessão do atendente no AutoISP:
    //  - GET /client_search/search?erp_id=X (ou pppoe_username=X) → [{gpon_client_id,  (sem conn_state: ver escolherOnu)
    //    contracted_service_id, olt_hostname, ponlink, serial_number, conn_state, erp_id, pppoe_username, ...}] (~0,25 s)
    //  - GET /gpon_clients/{id}/last_status_changes → [{class, text, data, created_at, trigger, previous_power}] (~0,2 s)
    //    class "rx-*" = leitura de sinal (text "-18.36 dBm"); "up" = ONU voltou; demais = queda
    //    ("power-fail" Sem Energia, "massive-power-fail" Massiva Energia, LOS etc.).
    //  A leitura em tempo real (Rx OLT) só chega por websocket após 15–90 s: fica no link "Abrir ONU no AutoISP".

    const AUTOISP_ORIGEM = 'https://autoisp.brasiltecpar.com.br';
    //  - GET /contracted_services/{id}.json → {gpon_client: {onu (ID da ONU), service_port, vlan, description, ...}} (~0,35 s)
    //  - GET /gpon_clients/{id}/l3_informations → {ip, mac, username, starttime, stoptime, sessiontime} (~0,3 s)
    //    IP da sessão: mais confiável que o da Amigo (pedido do usuário em 11/10/2026).
    //  Tipos de evento vistos: loss-signal (LOS), power-fail (Sem Energia = Dying Gasp/DGI),
    //  massive-power-fail (Massiva Energia), up (UP), rx-ok / rx-warning / rx-critical (leituras de sinal).
    //  STATUS ATUAL DA ONU — a mesma fonte da "Tabela de diagnóstico" do AutoISP (medido em 11/10/2026):
    //  - GET /client_search/diagnostics_search?topology=ftth&columns=…&erp_id=X → 1ª chamada {uuid, status:"enqueued"};
    //    repetindo a MESMA chamada, vem o resultado: [{erp_id, onu_status ("OK"|"loss_signal"|"down"|…),
    //    onu_rx_power, olt_rx_power, onu_status_updated_at, onu_last_off, onu_distance, onu_olt_description,
    //    cto_description, …}] em < 1 s. Colunas diferentes das da tela travam o processamento: usar exatamente estas.
    //  O histórico (last_status_changes) às vezes fica desatualizado (LOS de julho com a ONU OK hoje): ele só é usado
    //  quando o status atual não está disponível. (O websocket da tela recusa conexões vindas de fora do AutoISP.)
    //  - GET /gpon_clients/{id}/refresh_status.json?skip_power_graph=true pede leitura nova na OLT ("Ler agora na OLT").
    //  - GET /contracted_services/{id} (HTML) → "VLAN (do perfil)", "CTO" e "Perfil da ONU" (o JSON traz vlan vazia).
    const CAMINHO_AUTOISP_PERMITIDO = /^\/(?:client_search\/(?:search|diagnostics_search)|gpon_clients\/\d{1,12}\/(?:last_status_changes|l3_informations|refresh_status\.json)|contracted_services\/\d{1,12}(?:\.json)?|olts\/olts_list)$/;
    const COLUNAS_DIAGNOSTICO = 'erp_id,gpon_client_id,olt_id,ponlink,onu,serial_number,onu_rx_power,olt_rx_power,onu_status_updated_at,' +
        'onu_last_off,onu_distance,onu_olt_description,cto_description,remote,ct_city,ct_state,onu_status,short_serial_number,onu_status,splitter_id,port_sequence';
    const TENTATIVAS_DIAGNOSTICO = 10;  // ~0,6 s entre tentativas (resultado medido em < 1 s)
    const INTERVALO_DIAGNOSTICO_MS = 600;
    const ESPERA_LEITURA_OLT_MS = 15000; // "Ler agora na OLT": tempo da leitura nova (~15 s medido)
    const TEMPO_AUTOISP_MS = 15000;
    const CACHE_ONU_MS = 2 * 60 * 1000;
    // Faixas de sinal GPON (dBm) para classificar o RX da ONU.
    const SINAL = { maximo: -8, alerta: -25, minimo: -28 };

    function classificarSinal(valor) {
        if (typeof valor !== 'number' || Number.isNaN(valor)) return null;
        if (valor > SINAL.maximo) return { tipo: 'erro', rotulo: 'Saturado' };
        if (valor < SINAL.minimo) return { tipo: 'erro', rotulo: 'Crítico' };
        if (valor < SINAL.alerta) return { tipo: 'aviso', rotulo: 'Atenção' };
        return { tipo: 'ok', rotulo: 'Bom' };
    }

    // Classificação de sinal do próprio AutoISP (mais confiável que as nossas faixas, que ficam de reserva).
    const SINAL_AUTOISP = {
        'rx-ok': { tipo: 'ok', rotulo: 'Bom' },
        'rx-warning': { tipo: 'aviso', rotulo: 'Atenção' },
        'rx-critical': { tipo: 'erro', rotulo: 'Crítico' }
    };

    /**
     * Tipo de problema de um evento de queda da ONU. É isso que decide qual texto de diagnóstico
     * o atendente copia para o ticket.
     */
    // Classes reais vistas em 11/10/2026: loss-signal "LOS", power-fail "Sem Energia", down "Down",
    // unavailable "Não Disponível", massive-loss-signal "Massiva LOS", massive-power-fail "Massiva Energia".
    function tipoProblema(classe, texto) {
        const c = String(classe || '').toLowerCase(), t = String(texto || '').toLowerCase();
        if (c === 'up') return null;
        const perdaSinal = /loss|\blos\b/.test(c) || /\blos\b|perda de sinal/.test(t);
        const energia = /power|dying|dgi/.test(c) || /energia|dying|dgi/.test(t);
        if (/massive/.test(c) || /massiva/.test(t)) return perdaSinal ? 'massiva-los' : 'massiva';
        if (perdaSinal) return 'los';
        if (energia) return 'dgi';
        if (/unavailable/.test(c) || /n[ãa]o dispon[íi]vel/.test(t)) return 'indisponivel';
        return 'down';
    }

    const quandoEvento = e => textoLimpo(e && (e.data || e.created_at), 40);
    const instante = e => { const t = Date.parse(quandoEvento(e)); return Number.isNaN(t) ? 0 : t; };

    const TITULO_PROBLEMA = {
        los: 'LOS (sem sinal óptico)',
        dgi: 'Sem energia (DGI)',
        down: 'Down',
        indisponivel: 'Não disponível',
        'massiva-los': 'Massiva LOS (rompimento)',
        massiva: 'Massiva de energia'
    };

    /** Interpreta o histórico de eventos da ONU (mais recente primeiro). */
    function resumirEventosOnu(eventos) {
        const lista = (Array.isArray(eventos) ? eventos : [])
            .filter(e => e && typeof e === 'object')
            .map(e => ({ classe: textoLimpo(e.class, 40).toLowerCase(), texto: textoLimpo(e.text, 60), quando: quandoEvento(e), _t: instante(e) }))
            .sort((a, b) => b._t - a._t);
        const ehLeitura = e => e.classe.startsWith('rx') || /dBm/i.test(e.texto);
        const leitura = lista.find(ehLeitura);
        const estados = lista.filter(e => !ehLeitura(e));
        const atual = estados[0] || null;
        const queda = estados.find(e => e.classe !== 'up') || null;
        const valor = leitura ? parseFloat(leitura.texto.replace(',', '.')) : NaN;
        let estado = 'desconhecido';
        if (atual) estado = atual.classe === 'up' ? 'online' : 'offline';
        const limpar = e => (e ? { classe: e.classe, texto: e.texto, quando: e.quando, problema: tipoProblema(e.classe, e.texto) } : null);
        const problemaAtual = atual ? tipoProblema(atual.classe, atual.texto) : null;
        return {
            statusOnu: {
                estado,
                problema: problemaAtual, // 'los' | 'dgi' | 'massiva' | 'down' | null (UP ou sem eventos)
                texto: atual ? (atual.classe === 'up' ? 'Online (UP)' : TITULO_PROBLEMA[problemaAtual] || atual.texto || 'Queda') : '',
                quando: atual ? atual.quando : ''
            },
            sinal: leitura ? {
                valor: Number.isNaN(valor) ? null : valor, texto: leitura.texto, quando: leitura.quando,
                classe: leitura.classe, classificacao: SINAL_AUTOISP[leitura.classe] || classificarSinal(valor)
            } : null,
            ultimaQueda: limpar(queda),
            eventos: estados.slice(0, 5).map(limpar)
        };
    }

    /**
     * O histórico do AutoISP nem sempre registra o "UP" quando a ONU volta (visto em 11/10/2026: último evento
     * "LOS" de 28/07 com o cliente navegando desde as 09:43 de hoje). Por isso o último evento só vale como
     * estado ATUAL se não houver sessão ativa iniciada depois dele. Com sessão ativa mais nova, a ONU está online
     * e a queda vira só "última queda".
     */
    function corrigirPelaSessao(resumo, sessao) {
        const st = resumo.statusOnu;
        const s = sessao || {};
        const inicio = Date.parse(textoLimpo(s.starttime, 40));
        const ativa = !!textoLimpo(s.ip, 45) && !textoLimpo(s.stoptime, 40) && !Number.isNaN(inicio);
        if (!ativa || st.estado === 'online') return resumo;
        const quandoQueda = Date.parse(st.quando || '');
        if (st.estado === 'offline' && !Number.isNaN(quandoQueda) && quandoQueda > inicio) return resumo; // queda depois da sessão: vale
        return {
            ...resumo,
            statusOnu: { estado: 'online', problema: null, texto: 'Online (sessão ativa)', quando: textoLimpo(s.starttime, 40), corrigidoPelaSessao: true }
        };
    }

    const dbm = v => {
        const n = parseFloat(String(v === null || v === undefined ? '' : v).replace(',', '.'));
        return Number.isNaN(n) ? null : n;
    };

    // onu_status da tabela de diagnóstico que significam ONU LIGADA: o valor é a faixa do sinal, não uma queda.
    // Medido em 13/10/2026: "warning" com ONU UP e RX −26,58 dBm (antes virava "Down" por engano).
    const STATUS_ONU_ONLINE = {
        ok: { tipo: 'ok', rotulo: 'Bom' },
        up: null, online: null,
        warning: { tipo: 'aviso', rotulo: 'Atenção' },
        critical: { tipo: 'erro', rotulo: 'Crítico' }
    };
    // Valores de queda conhecidos. Qualquer outro valor fica "desconhecido" e o histórico decide,
    // em vez de inventar um "Down".
    const STATUS_ONU_QUEDA = /^(?:massive-)?(?:loss-signal|los|down|power-fail|dying-gasp|dgi|unavailable|offline)$/;

    /**
     * Linha da "Tabela de diagnóstico" do AutoISP → status atual da ONU.
     * onu_status: "OK"/"warning"/"critical" = online (faixa do sinal);
     * "loss_signal", "down", "massive_loss_signal", "power_fail", "unavailable"… = queda.
     */
    function interpretarDiagnostico(l) {
        if (!l || typeof l !== 'object') return null;
        const bruto = textoLimpo(l.onu_status, 40);
        const classe = bruto.toLowerCase().replace(/_/g, '-');
        const semPrefixo = classe.replace(/^rx-/, '');
        let estado = 'desconhecido', problema = null;
        if (Object.prototype.hasOwnProperty.call(STATUS_ONU_ONLINE, semPrefixo)) estado = 'online';
        else if (STATUS_ONU_QUEDA.test(classe)) { estado = 'offline'; problema = tipoProblema(classe, bruto.replace(/_/g, ' ')); }
        const rxOnu = dbm(l.onu_rx_power), rxOlt = dbm(l.olt_rx_power);
        const distancia = dbm(l.onu_distance);
        const sinalOk = estado === 'online' && rxOnu !== null && rxOnu !== 0;
        // Faixa do sinal: a do AutoISP quando ele informa (warning/critical), senão as nossas faixas.
        const faixaAutoIsp = estado === 'online' ? STATUS_ONU_ONLINE[semPrefixo] : null;
        const rotuloOnline = semPrefixo === 'ok' || !faixaAutoIsp ? 'Online (OK)' : `Online (sinal ${faixaAutoIsp.rotulo.toLowerCase()})`;
        return {
            estado, problema, classe,
            texto: estado === 'online' ? rotuloOnline : (TITULO_PROBLEMA[problema] || bruto || ''),
            statusDesde: textoLimpo(l.onu_status_updated_at, 40), // desde quando a ONU está neste status
            rxOnu: sinalOk ? `${rxOnu} dBm` : '',
            rxOlt: estado === 'online' && rxOlt !== null && rxOlt !== 0 ? `${rxOlt} dBm` : '',
            sinal: sinalOk ? { valor: rxOnu, texto: `${rxOnu} dBm`, quando: textoLimpo(l.onu_status_updated_at, 40), classe: '', classificacao: faixaAutoIsp || classificarSinal(rxOnu), atual: true } : null,
            distancia: distancia === null ? '' : (distancia >= 1000 ? `${(distancia / 1000).toFixed(2).replace('.', ',')} km` : `${Math.round(distancia)} m`),
            ultimoOff: textoLimpo(l.onu_last_off, 40),
            cto: textoLimpo(l.cto_description, 200),
            descricaoOlt: textoLimpo(l.onu_olt_description, 200),
            modelo: '', firmware: '', causaOff: ''
        };
    }

    /**
     * Junta o status atual (tabela de diagnóstico) ao resumo do histórico. O status atual manda; sem ele,
     * vale o histórico corrigido pela sessão (corrigirPelaSessao).
     */
    function mesclarStatusAtual(resumo, atual) {
        if (!atual || atual.estado === 'desconhecido') return { ...resumo, statusAtual: atual || null };
        const quando = atual.estado === 'offline'
            ? (atual.ultimoOff || atual.statusDesde || (resumo.statusOnu && resumo.statusOnu.estado === 'offline' ? resumo.statusOnu.quando : ''))
            : '';
        return {
            ...resumo,
            statusOnu: { estado: atual.estado, problema: atual.problema, texto: atual.texto, quando, fonte: 'status' },
            // Sinal: o atual; se a ONU caiu, fica a última leitura do histórico.
            sinal: atual.sinal || resumo.sinal,
            statusAtual: atual
        };
    }

    /** Campos da página HTML do serviço: "VLAN (do perfil)", "CTO" e "Perfil da ONU". */
    function camposPaginaServico(html) {
        const campo = rotulo => {
            const re = new RegExp(`<b>\\s*${rotulo}\\s*</b>\\s*<br\\s*/?>\\s*([^<]{0,200})`, 'i');
            const m = String(html || '').match(re);
            return m ? textoLimpo(m[1], 200) : '';
        };
        return { vlanPerfil: campo('VLAN \\(do perfil\\)'), cto: campo('CTO'), perfilOnu: campo('Perfil da ONU') };
    }

    /**
     * Escolhe, entre os resultados da busca, o cliente cujo ERP ID ou usuário PPPoE é exatamente o termo.
     * A busca é feita sem filtro de situação (cliente bloqueado também tem ONU); havendo mais de um, vale o que
     * tem ONU provisionada (serial/OLT) e não está cancelado.
     */
    function escolherOnu(lista, termo) {
        const alvo = chave(termo);
        const exatos = (Array.isArray(lista) ? lista : []).filter(i => i && (chave(i.erp_id) === alvo || chave(i.pppoe_username) === alvo));
        const pontos = i => (i.serial_number || i.olt_hostname ? 2 : 0) + (/cancel/i.test(String(i.conn_state || '')) ? 0 : 1);
        return exatos.sort((a, b) => pontos(b) - pontos(a))[0] || null;
    }

    function criarClienteAutoIsp({
        fetchFn, agora = () => Date.now(), tempoMs = TEMPO_AUTOISP_MS,
        esperar = ms => new Promise(r => setTimeout(r, ms)),
        intervaloDiagnosticoMs = INTERVALO_DIAGNOSTICO_MS, esperaLeituraOltMs = ESPERA_LEITURA_OLT_MS
    } = {}) {
        const cache = new Map();
        const consultas = new Map();

        async function executar(caminho, params, { html = false } = {}) {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), tempoMs);
            const qs = params ? '?' + new URLSearchParams(params).toString() : '';
            try {
                const resp = await fetchFn(AUTOISP_ORIGEM + caminho + qs, {
                    credentials: 'include', signal: ctrl.signal,
                    headers: html ? { Accept: 'text/html' } : { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' }
                });
                let destino = '';
                try { destino = new URL(resp.url || AUTOISP_ORIGEM + caminho).pathname; } catch (e) { /* URL inválida */ }
                if (/\/users\/sign_in\b/.test(destino) || resp.status === 401 || resp.status === 403) {
                    throw new ErroAmigo('Você não está logado no AutoISP. Faça login no AutoISP e clique em Atualizar.', 'LOGIN_AUTOISP');
                }
                if (!resp.ok) throw new ErroAmigo(`O AutoISP respondeu com erro (HTTP ${resp.status}).`, 'HTTP');
                const texto = await resp.text();
                if (html) {
                    if (/name=["']user\[password\]["']/i.test(texto)) throw new ErroAmigo('Você não está logado no AutoISP. Faça login no AutoISP e clique em Atualizar.', 'LOGIN_AUTOISP');
                    return texto;
                }
                return parseJson(texto, 'AutoISP');
            } catch (e) {
                if (e instanceof ErroAmigo) {
                    if (e.codigo === 'FORMATO') throw new ErroAmigo('Resposta inesperada do AutoISP (verifique se está logado).', 'LOGIN_AUTOISP');
                    throw e;
                }
                if (e && e.name === 'AbortError') throw new ErroAmigo('O AutoISP demorou demais para responder.', 'TIMEOUT');
                throw new ErroAmigo('AutoISP inacessível. Verifique a conexão/VPN.', 'REDE');
            } finally {
                clearTimeout(timer);
            }
        }

        function requisitar(caminho, params, opcoes) {
            if (!CAMINHO_AUTOISP_PERMITIDO.test(caminho)) return Promise.reject(new ErroAmigo('Endereço do AutoISP não permitido.', 'ENTRADA'));
            return executar(caminho, params, opcoes);
        }

        /**
         * Status atual da ONU pela "Tabela de diagnóstico" do AutoISP. A 1ª chamada enfileira a busca
         * ({status:"enqueued"}); repetindo a mesma chamada vem o resultado (array). < 1 s medido.
         */
        async function lerDiagnostico(erpId) {
            const erp = textoLimpo(erpId, 64);
            if (!ETIQUETA_VALIDA.test(erp)) throw new ErroAmigo('ERP ID inválido.', 'ENTRADA');
            const params = { topology: 'ftth', columns: COLUNAS_DIAGNOSTICO, erp_id: erp };
            for (let i = 0; i < TENTATIVAS_DIAGNOSTICO; i++) {
                if (i) await esperar(intervaloDiagnosticoMs);
                const r = await requisitar('/client_search/diagnostics_search', params);
                if (Array.isArray(r)) {
                    const linha = r.find(x => x && x.erp_id === erp) || null;
                    if (!linha) throw new ErroAmigo('ONU não está na tabela de diagnóstico do AutoISP.', 'NAO_ENCONTRADO');
                    return interpretarDiagnostico(linha);
                }
                if (!r || typeof r !== 'object' || !/enqueued|running|processing|pending/i.test(String(r.status || ''))) {
                    throw new ErroAmigo('Resposta inesperada da tabela de diagnóstico do AutoISP.', 'FORMATO');
                }
            }
            throw new ErroAmigo('A tabela de diagnóstico do AutoISP não respondeu a tempo.', 'TIMEOUT');
        }

        /** "Ler agora na OLT": pede leitura nova (o que a página da ONU faz ao abrir) e aguarda ~15 s. */
        async function pedirLeituraOlt(gponId) {
            await requisitar(`/gpon_clients/${gponId}/refresh_status.json`, { skip_power_graph: 'true' }).catch(() => null);
            await esperar(esperaLeituraOltMs);
        }

        /** Dado complementar: falha vira null (só falta de login interrompe). */
        const opcional = p => p.catch(e => { if (e.codigo === 'LOGIN_AUTOISP') throw e; return null; });

        async function montar(termos, { aoVivo = false } = {}) {
            let cliente = null, termoUsado = null;
            for (const { campo, valor } of termos) {
                // Sem conn_state: com conn_state=1 (só ativos) cliente BLOQUEADO virava "ONU não encontrada" (06/11/2026).
                const lista = await requisitar('/client_search/search', { [campo]: valor });
                cliente = escolherOnu(lista, valor);
                if (cliente) { termoUsado = campo; break; }
            }
            if (!cliente) throw new ErroAmigo('ONU não encontrada no AutoISP para esta etiqueta.', 'NAO_ENCONTRADO');
            const gponId = somenteDigitos(cliente.gpon_client_id);
            const servico = somenteDigitos(cliente.contracted_service_id);
            if (aoVivo && gponId) await pedirLeituraOlt(gponId);
            // Em paralelo (< 1 s): status atual (tabela de diagnóstico), histórico, cadastro (ID da ONU, service port),
            // página do serviço (VLAN do perfil, CTO) e sessão (IP).
            let erroStatusAtual = '';
            const [gpon, eventos, cadastro, pagina, sessao] = await Promise.all([
                // Falha no status atual não derruba o resto, mas o motivo vai para a tela (statusAtualErro).
                lerDiagnostico(cliente.erp_id).catch(e => {
                    if (e.codigo === 'LOGIN_AUTOISP') throw e;
                    erroStatusAtual = (e && e.message) || 'erro desconhecido';
                    return null;
                }),
                gponId ? opcional(requisitar(`/gpon_clients/${gponId}/last_status_changes`)) : null,
                servico ? opcional(requisitar(`/contracted_services/${servico}.json`)) : null,
                servico ? opcional(requisitar(`/contracted_services/${servico}`, null, { html: true })) : null,
                gponId ? opcional(requisitar(`/gpon_clients/${gponId}/l3_informations`)) : null
            ]);
            const g = (cadastro && typeof cadastro.gpon_client === 'object' && cadastro.gpon_client) || {};
            const s = sessao && typeof sessao === 'object' && !Array.isArray(sessao) ? sessao : {};
            const p = camposPaginaServico(pagina);
            const valorOuVazio = v => (v === null || v === undefined ? '' : textoLimpo(v, 80));
            // Status atual manda; sem ele, o histórico corrigido pela sessão.
            const resumo = mesclarStatusAtual(corrigirPelaSessao(resumirEventosOnu(eventos || []), s), gpon);
            return {
                consultadoEm: agora(),
                encontradoPor: termoUsado,
                gponId,
                olt: textoLimpo(cliente.olt_hostname, 80),
                oltId: somenteDigitos(cliente.olt_id),
                ponlink: textoLimpo(cliente.ponlink, 20),
                onuId: valorOuVazio(g.onu),
                servicePort: valorOuVazio(g.service_port),
                vlan: valorOuVazio(g.vlan) || p.vlanPerfil, // a VLAN real costuma vir do perfil
                descricaoOlt: valorOuVazio(g.description) || (gpon ? gpon.descricaoOlt : ''),
                cto: p.cto || (gpon ? gpon.cto : ''),
                perfilOnu: p.perfilOnu,
                statusAtualErro: gpon ? '' : erroStatusAtual,
                serial: textoLimpo(cliente.serial_number, 40),
                estadoAutoIsp: textoLimpo(cliente.conn_state, 30),
                sessao: {
                    ip: textoLimpo(s.ip, 45),
                    mac: textoLimpo(s.mac, 40).toUpperCase(),
                    usuario: textoLimpo(s.username, 100),
                    inicio: textoLimpo(s.starttime, 40),
                    fim: textoLimpo(s.stoptime, 40)
                },
                link: servico ? `${AUTOISP_ORIGEM}/contracted_services/${servico}` : (gponId ? `${AUTOISP_ORIGEM}/gpon_clients/${gponId}` : ''),
                ...resumo
            };
        }

        /**
         * Dados da ONU pela etiqueta (ERP ID) e, se informado, pelo usuário PPPoE.
         * Ordem: erp_id=etiqueta → pppoe_username=usuário → pppoe_username=etiqueta. Cache de 2 min.
         */
        function consultarOnu(etiquetaBruta, usuarioBruto, { forcar = false, aoVivo = false } = {}) {
            if (aoVivo) forcar = true; // leitura nova na OLT nunca vem do cache
            const etiqueta = String(etiquetaBruta || '').trim();
            const usuario = String(usuarioBruto || '').trim();
            if (!ETIQUETA_VALIDA.test(etiqueta)) return Promise.reject(new ErroAmigo('Etiqueta inválida.', 'ENTRADA'));
            // A busca por ERP ID do AutoISP é exata e diferencia maiúsculas (etiquetas são maiúsculas).
            const termos = [{ campo: 'erp_id', valor: etiqueta.toUpperCase() }];
            if (etiqueta !== etiqueta.toUpperCase()) termos.push({ campo: 'erp_id', valor: etiqueta });
            if (usuario && USUARIO_VALIDO.test(usuario) && usuario.toLowerCase() !== etiqueta.toLowerCase()) termos.push({ campo: 'pppoe_username', valor: usuario });
            termos.push({ campo: 'pppoe_username', valor: etiqueta });
            const k = `${etiqueta.toUpperCase()}|${usuario.toLowerCase()}`;
            const kConsulta = k + (aoVivo ? '|aovivo' : '');
            const salvo = cache.get(k);
            if (!forcar && salvo && agora() - salvo.em < CACHE_ONU_MS) return Promise.resolve({ ...salvo.valor, doCache: true });
            if (consultas.has(kConsulta)) return consultas.get(kConsulta);
            const p = montar(termos, { aoVivo }).then(valor => {
                cache.set(k, { em: agora(), valor });
                if (cache.size > 300) cache.delete(cache.keys().next().value);
                return valor;
            });
            consultas.set(kConsulta, p);
            const limpar = () => consultas.delete(kConsulta);
            p.then(limpar, limpar);
            return p;
        }

        /** IP da OLT pelo ID do AutoISP (lista de OLTs filtrada pelo ID; ~0,4 s; cache de 6 h). */
        const cacheOlts = new Map();
        async function ipOlt(oltIdBruto) {
            const id = somenteDigitos(oltIdBruto);
            if (!id || id.length > 9) throw new ErroAmigo('OLT inválida.', 'ENTRADA');
            const salvo = cacheOlts.get(id);
            if (salvo && agora() - salvo.em < CACHE_IP_OLT_MS) return salvo.valor;
            const json = await requisitar('/olts/olts_list', { olt_id: id, page: '1', items: '20', hide_deactivated: 'false' });
            const valor = ipDaListaOlts(json, id);
            cacheOlts.set(id, { em: agora(), valor });
            if (cacheOlts.size > 200) cacheOlts.delete(cacheOlts.keys().next().value);
            return valor;
        }

        return { consultarOnu, ipOlt, _requisitar: requisitar, _lerDiagnostico: lerDiagnostico };
    }

    const api = {
        AMIGO_ORIGEM, AUTOISP_ORIGEM, ETIQUETA_VALIDA, BUSCA_SPLITTER_VALIDA, ENTIDADE_CTO, TEMPO, SINAL,
        ErroAmigo, decodificarEntidades, textoLimpo, resumirLinha, escolherConexao, interpretarStatusRadius,
        nomeSplitterDaEdicao, resumirBuscaSplitter, formatarLimite, linhasDaLista, criarClienteAmigo,
        classificarSinal, resumirEventosOnu, escolherOnu, criarClienteAutoIsp, tipoProblema, TITULO_PROBLEMA, corrigirPelaSessao,
        interpretarDiagnostico, mesclarStatusAtual, camposPaginaServico,
        lerAbordagemDaEdicao, normalizarSerial, slotPortaDoPon, compararAbordagem,
        parametrosTabelaAtivos, ipDaTabelaAtivos, ipDaListaOlts, IPV4_VALIDO
    };
    if (typeof module === 'object' && module.exports) module.exports = api;
    else escopo.AmigoCore = api;
})(typeof self !== 'undefined' ? self : globalThis);
