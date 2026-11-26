/**
 * Testes do núcleo da integração com a Amigo (amigo-core.js).
 * Rodar:  node --test tests/amigo-core.test.js
 * Todos os dados são FICTÍCIOS (nenhum cliente real).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../amigo-core.js');

// ------------------------------------------------------------
// Servidor Amigo simulado
// ------------------------------------------------------------

const ORIGEM = 'https://plataforma.sejaamigo.com.br';

function resposta(corpo, { status = 200, url = null } = {}) {
    const texto = typeof corpo === 'string' ? corpo : JSON.stringify(corpo);
    return { ok: status >= 200 && status < 300, status, url, text: async () => texto };
}

/**
 * rotas: [{ re: RegExp do caminho, metodo?, fn(match, corpo, opcoes) → resposta | Promise }]
 * Registra concorrência máxima e a ordem das chamadas.
 */
function servidorFalso(rotas, { atraso = 5 } = {}) {
    const log = [];
    let ativos = 0, maxAtivos = 0;
    const fetchFn = async (url, opcoes = {}) => {
        const caminho = url.replace(ORIGEM, '');
        const corpo = opcoes.body ? Object.fromEntries(new URLSearchParams(opcoes.body)) : {};
        log.push({ caminho, metodo: opcoes.method || 'GET', corpo });
        ativos++; maxAtivos = Math.max(maxAtivos, ativos);
        // Como o fetch real: o AbortSignal interrompe a qualquer momento.
        const abortado = new Promise((_, reject) => {
            if (opcoes.signal) opcoes.signal.addEventListener('abort', () => { const e = new Error('abort'); e.name = 'AbortError'; reject(e); });
        });
        const atender = async () => {
            await new Promise(r => setTimeout(r, atraso));
            for (const r of rotas) {
                const m = caminho.match(r.re);
                if (m && (!r.metodo || r.metodo === (opcoes.method || 'GET'))) {
                    const out = await r.fn(m, corpo, opcoes);
                    if (out && out.url === null) out.url = url;
                    return out;
                }
            }
            return resposta('não encontrado', { status: 404, url });
        };
        try {
            return await Promise.race([atender(), abortado]);
        } finally {
            ativos--;
        }
    };
    return { fetchFn, log, max: () => maxAtivos };
}

const linha = (o = {}) => ({
    id: 1001, offerName: 'Plano Fictício 500 Mega', userPPPoE: 'cliente.teste', personName: 'Fulano de Teste',
    connectionType: 'PPPoe Varejo', serviceTag: 'TESTE12345', status: 'Normal', enabled: true,
    fkNetworkDocumentationActiveIdCeName: 'CE-TESTE-01', fkNetworkDocumentationActivesIdApName: 'UPE-TESTE-01',
    onuSn: 'ABCD00000001', fkNetworkDocumentationCtoId: 777, slot: 3, portNumber: 5, userIpoe: null, ...o
});

// Equipamento com uptime ZERADO de propósito: o status não pode depender dele (caso real reportado).
const EQUIP = { equipmentType: 'Roteador', equipmentUser: 'admin', equipmentPassword: 'senha-ficticia', firmware: 'v1.0', model: 'X1',
    currentIp: '100.64.0.10', conectionUptime: '00:00:00', macAddress: 'aa:bb:cc:00:11:22', uploadLimit: '200', downloadLimit: '500' };
const CONTRATO = { name: '', user: 'cliente.teste', password: 'x', offerName: '', status: 'Normal', massive: [], statusOlt: 'FULL' };
const RADIUS_ON = { userfound: true, acctstarttime: '09-10-2026 09:18:40', acctupdatetime: '09-10-2026 09:18:40', acctstoptime: null };
const RADIUS_OFF = { userfound: true, acctstarttime: '08-10-2026 10:00:00', acctupdatetime: '09-10-2026 07:00:00', acctstoptime: '09-10-2026 07:05:00' };
const RADIUS_NAO_ENCONTRADO = () => resposta({ message: "Couldn't retrieve connection status data, exception: HTTP/1.1 404 Not Found returned for ..." }, { status: 500 });

function rotasPadrao({ lista = [linha()], radius = () => resposta(RADIUS_ON), equipamento = () => resposta(EQUIP), contrato = () => resposta(CONTRATO) } = {}) {
    return [
        { re: /^\/pt\/network-documentation\/connection\/json$/, metodo: 'POST', fn: (m, c) => {
            const tag = c['filters[serviceTag]'];
            const filtrada = tag !== undefined ? lista.filter(i => String(i.serviceTag || '').toLowerCase().includes(tag.toLowerCase())) : [];
            return resposta({ data: filtrada, recordsTotal: filtrada.length, recordsFiltered: filtrada.length });
        } },
        { re: /^\/pt\/network-documentation\/connection-status\/connection$/, metodo: 'POST', fn: (m, c) => radius(c.pppoeUsername) },
        { re: /^\/pt\/network-documentation\/(\d+)\/cpe-equipment-info\/connection$/, fn: (m) => equipamento(m[1]) },
        { re: /^\/pt\/network-documentation\/(\d+)\/cpe-customer-info\/connection$/, fn: (m) => contrato(m[1]) }
    ];
}

const cliente = (srv, extra = {}) => core.criarClienteAmigo({
    fetchFn: srv.fetchFn, esperar: () => Promise.resolve(), ...extra
});

// ------------------------------------------------------------
// Funções puras
// ------------------------------------------------------------

test('textoLimpo remove tags e decodifica entidades sem devolver HTML', () => {
    assert.equal(core.textoLimpo('<b>Jo&atilde;o</b> &amp; Cia &#39;X&#39; &#x41;'), 'João & Cia \'X\' A');
    assert.equal(core.textoLimpo('Concei&ccedil;&Atilde;O &foo;'), 'ConceiçÃO &foo;');
    assert.equal(core.textoLimpo('<img src=x onerror=alert(1)>Nome'), 'Nome');
    assert.equal(core.textoLimpo(null), '');
    assert.equal(core.textoLimpo('a'.repeat(500), 10), 'aaaaaaaaaa');
});

test('interpretarStatusRadius segue a regra da Amigo: Online ⇔ sem acctstoptime', () => {
    const on = core.interpretarStatusRadius(RADIUS_ON);
    assert.equal(on.estado, 'online');
    assert.equal(on.inicio, '09-10-2026 09:18:40');
    assert.match(on.motivo, /Online/);
    const off = core.interpretarStatusRadius(RADIUS_OFF);
    assert.equal(off.estado, 'offline');
    assert.equal(off.fim, '09-10-2026 07:05:00');
    assert.equal(core.interpretarStatusRadius({ ...RADIUS_ON, acctstoptime: '' }).estado, 'online');
    assert.equal(core.interpretarStatusRadius({ userfound: false }).estado, 'offline');
    assert.throws(() => core.interpretarStatusRadius(null), e => e.codigo === 'FORMATO');
    assert.throws(() => core.interpretarStatusRadius([]), e => e.codigo === 'FORMATO');
});

test('escolherConexao exige correspondência exata e prefere a conexão ativa', () => {
    const lista = [
        linha({ id: 1, serviceTag: 'TESTE123456' }),                              // só "parecida"
        linha({ id: 2, serviceTag: 'teste12345', enabled: false, status: 'Bloqueado' }),
        linha({ id: 3, serviceTag: 'TESTE12345', enabled: true, status: 'Normal' }),
        linha({ id: 4, serviceTag: 'OUTRA', userPPPoE: 'TESTE12345' })            // usuário igual, etiqueta diferente
    ];
    const r = core.escolherConexao(lista, ' teste12345 ');
    assert.equal(r.escolhida.id, 3);
    assert.equal(r.exatos, 3);
    assert.equal(core.escolherConexao([linha({ serviceTag: 'TESTE123456' })], 'TESTE12345').escolhida, null);
});

test('nomeSplitterDaEdicao acha o nome pelo ID exato, mesmo numa página grande', () => {
    const opcoes = Array.from({ length: 5000 }, (_, i) => `<option value="${i + 10}">CTO-${i}-BAIRRO</option>`).join('');
    const html = `<select id="connectionApproach_fkNetworkDocumentationOltId">${opcoes}</select>
        <script>var newOption = new Option('SPO-OLT-01', '777', false, true);
        var newOption = new Option('CTO-042-BAIRRO \\'TESTE\\'', '9031', false, false);
        $('#connectionApproach_fkNetworkDocumentationCtoId').append(newOption);</script>`;
    const t0 = process.hrtime.bigint();
    assert.equal(core.nomeSplitterDaEdicao(html, '9031'), "CTO-042-BAIRRO 'TESTE'");
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 50, `levou ${ms} ms`);
    assert.equal(core.nomeSplitterDaEdicao(html, '12345678'), null);
    assert.equal(core.nomeSplitterDaEdicao(html, 'abc'), null);
    const html2 = '<select id="connectionApproach_fkNetworkDocumentationCtoId"><option value="55" selected>CTO-055-CENTRO</option></select>';
    assert.equal(core.nomeSplitterDaEdicao(html2, 55), 'CTO-055-CENTRO');
});

test('resumirBuscaSplitter remove repetidos e ignora itens inválidos', () => {
    const r = core.resumirBuscaSplitter([{ id: 1, name: 'CTO-1' }, { id: 1, name: 'CTO-1' }, { id: 'x', name: 'Y' }, { id: 2, text: '<b>CTO-2</b>' }]);
    assert.deepEqual(r, [{ id: '1', nome: 'CTO-1' }, { id: '2', nome: 'CTO-2' }]);
});

test('ENTIDADE_CTO é a entidade de CTO da Amigo', () => {
    assert.equal(Buffer.from(core.ENTIDADE_CTO, 'base64').toString(), 'App\\Entity\\Panel\\NetworkDocumentation\\Cto');
});

// ------------------------------------------------------------
// Diagnóstico (status pelo "Status da Conexão" da Amigo)
// ------------------------------------------------------------

test('cliente ONLINE no RADIUS aparece Online mesmo com uptime 00:00:00 (caso real reportado)', async () => {
    const srv = servidorFalso(rotasPadrao());
    const d = await cliente(srv).consultarCliente('teste12345');
    assert.equal(d.estado, 'online');
    assert.equal(d.sessaoInicio, '09-10-2026 09:18:40');
    assert.equal(d.conexao.id, '1001');
    assert.equal(d.conexao.ctoId, '777');
    assert.equal(d.ip, '100.64.0.10');
    assert.equal(d.mac, 'AA:BB:CC:00:11:22');
    assert.equal(d.limite, '↓ 500  ·  ↑ 200');
    assert.equal(d.contrato, 'Normal');
    assert.ok(!('uptime' in d), 'uptime não faz mais parte do diagnóstico');
    // O usuário enviado ao RADIUS é o "user" do cliente (o mesmo da tela Conectividade).
    const st = srv.log.find(l => l.caminho.includes('connection-status'));
    assert.equal(st.corpo.pppoeUsername, 'cliente.teste');
    assert.equal(srv.log.length, 4);
    assert.ok(srv.log.every(l => !/\/(view|edit)$/.test(l.caminho)));
});

test('sessão encerrada no RADIUS → Offline com horário da desconexão', async () => {
    const srv = servidorFalso(rotasPadrao({ radius: () => resposta(RADIUS_OFF), equipamento: () => resposta({ ...EQUIP, conectionUptime: '05:00:00' }) }));
    const d = await cliente(srv).consultarCliente('TESTE12345');
    assert.equal(d.estado, 'offline', 'uptime do equipamento não pode virar Online');
    assert.equal(d.sessaoFim, '09-10-2026 07:05:00');
});

test('usuário sem registro no RADIUS (HTTP 500 + Not Found) → Offline, sem repetir', async () => {
    let n = 0;
    const srv = servidorFalso(rotasPadrao({ radius: () => { n++; return RADIUS_NAO_ENCONTRADO(); } }));
    const d = await cliente(srv).consultarCliente('TESTE12345');
    assert.equal(d.estado, 'offline');
    assert.match(d.motivo, /RADIUS/);
    assert.equal(n, 1);
});

test('falha na consulta de status → repete uma vez; persistindo, Indeterminado (nunca Offline) e sem cache', async () => {
    let n = 0;
    const srv = servidorFalso(rotasPadrao({ radius: () => { n++; return resposta('<html>erro</html>', { status: 502 }); } }));
    const c = cliente(srv);
    const d = await c.consultarCliente('TESTE12345');
    assert.equal(d.estado, 'indeterminado');
    assert.match(d.motivo, /HTTP 502/);
    assert.equal(n, 2);
    await c.consultarCliente('TESTE12345');
    assert.equal(n, 4, 'indeterminado não deve vir do cache');

    let m = 0;
    const srv2 = servidorFalso(rotasPadrao({ radius: () => (m++ === 0 ? resposta('x', { status: 503 }) : resposta(RADIUS_ON)) }));
    assert.equal((await cliente(srv2).consultarCliente('TESTE12345')).estado, 'online');

    // Tempo esgotado de verdade (o RADIUS nunca responde).
    const lento = servidorFalso(rotasPadrao({ radius: () => new Promise(() => {}) }));
    const c3 = core.criarClienteAmigo({ fetchFn: lento.fetchFn, esperar: () => Promise.resolve(), tempos: { pagina: 30 } });
    const d3 = await c3.consultarCliente('TESTE12345');
    assert.equal(d3.estado, 'indeterminado');
    assert.match(d3.motivo, /demorou demais/);
});

test('resposta fora do formato no status → Indeterminado', async () => {
    const srv = servidorFalso(rotasPadrao({ radius: () => resposta('<html>ok</html>') }));
    assert.equal((await cliente(srv).consultarCliente('TESTE12345')).estado, 'indeterminado');
});

test('cadastro do cliente indisponível: usa o usuário PPPoE da lista', async () => {
    const srv = servidorFalso(rotasPadrao({ contrato: () => resposta('x', { status: 500 }), lista: [linha({ userPPPoE: 'usuario.da.lista' })] }));
    const d = await cliente(srv).consultarCliente('TESTE12345');
    assert.equal(d.estado, 'online');
    assert.equal(srv.log.find(l => l.caminho.includes('connection-status')).corpo.pppoeUsername, 'usuario.da.lista');
});

test('sem nenhum usuário PPPoE → Indeterminado e não consulta o RADIUS', async () => {
    const srv = servidorFalso(rotasPadrao({ contrato: () => resposta({ ...CONTRATO, user: '' }), lista: [linha({ userPPPoE: null, userIpoe: null })] }));
    const d = await cliente(srv).consultarCliente('TESTE12345');
    assert.equal(d.estado, 'indeterminado');
    assert.ok(!srv.log.some(l => l.caminho.includes('connection-status')));
});

test('equipamento indisponível não impede o status', async () => {
    const srv = servidorFalso(rotasPadrao({ equipamento: () => resposta('x', { status: 500 }) }));
    const d = await cliente(srv).consultarCliente('TESTE12345');
    assert.equal(d.estado, 'online');
    assert.equal(d.ip, '');
});

test('massivas: conta e devolve os IDs para o link da Amigo', async () => {
    const srv = servidorFalso(rotasPadrao({ contrato: () => resposta({ ...CONTRATO, massive: [{ id: 317 }, { id: 'x' }] }) }));
    const d = await cliente(srv).consultarCliente('TESTE12345');
    assert.equal(d.massivas, 2);
    assert.deepEqual(d.massivasIds, ['317']);
});

test('statusConexao (verificação em massa) usa o usuário informado ou lê o cadastro', async () => {
    const srv = servidorFalso(rotasPadrao({ radius: u => resposta(u === 'on.user' ? RADIUS_ON : RADIUS_OFF) }));
    const c = cliente(srv);
    assert.equal((await c.statusConexao({ idConexao: '1', usuario: 'on.user' })).estado, 'online');
    assert.equal(srv.log.length, 1);
    assert.equal((await c.statusConexao({ idConexao: '1' })).estado, 'offline'); // user do cadastro = cliente.teste
    assert.ok(srv.log.some(l => l.caminho.includes('cpe-customer-info')));
});

// ------------------------------------------------------------
// Fila, cache, login, entradas
// ------------------------------------------------------------

test('fila: uma requisição por vez na Amigo, mesmo com vários tickets consultando juntos', async () => {
    const lista = ['A1', 'A2', 'A3', 'A4', 'A5'].map((t, i) => linha({ id: 2000 + i, serviceTag: t }));
    const srv = servidorFalso(rotasPadrao({ lista }), { atraso: 10 });
    const c = cliente(srv);
    const rs = await Promise.all(lista.map(l => c.consultarCliente(l.serviceTag)));
    assert.ok(rs.every(r => r.estado === 'online'));
    assert.equal(srv.max(), 1);
});

test('fila: prioridade alta passa na frente da baixa', async () => {
    const srv = servidorFalso(rotasPadrao(), { atraso: 10 });
    const c = cliente(srv);
    const baixa = [1, 2, 3].map(i => c.statusConexao({ idConexao: String(3000 + i), usuario: `u${i}` }, { prioridade: 'baixa' }));
    const alta = c.consultarCliente('TESTE12345');
    await Promise.all([...baixa, alta]);
    const idxAlta = srv.log.findIndex(l => l.caminho.includes('connection/json'));
    assert.ok(idxAlta <= 1, `consulta do ticket entrou na posição ${idxAlta}`);
});

test('mesma etiqueta em dois tickets ao mesmo tempo → uma consulta só; depois vem do cache', async () => {
    const srv = servidorFalso(rotasPadrao());
    const c = cliente(srv);
    const [a, b] = await Promise.all([c.consultarCliente('TESTE12345'), c.consultarCliente('teste12345')]);
    assert.equal(a.conexao.id, b.conexao.id);
    assert.equal(srv.log.length, 4);
    const d = await c.consultarCliente('TESTE12345');
    assert.equal(d.doCache, true);
    assert.equal(srv.log.length, 4);
    await c.consultarCliente('TESTE12345', { forcar: true });
    assert.equal(srv.log.length, 8);
});

test('cache expira em 2 minutos', async () => {
    let agora = 1_000_000;
    const srv = servidorFalso(rotasPadrao());
    const c = core.criarClienteAmigo({ fetchFn: srv.fetchFn, esperar: () => Promise.resolve(), agora: () => agora });
    await c.consultarCliente('TESTE12345');
    agora += 119_000;
    assert.equal((await c.consultarCliente('TESTE12345')).doCache, true);
    agora += 2_000;
    assert.equal((await c.consultarCliente('TESTE12345')).doCache, undefined);
});

test('sem login na Amigo → LOGIN_REQUIRED (redirecionamento, 401 ou formulário de login)', async () => {
    for (const r of [
        () => resposta('<html></html>', { url: ORIGEM + '/pt/login' }),
        () => resposta('', { status: 401 }),
        () => resposta('<form><input name="_csrf_token"><input name="_password"></form>')
    ]) {
        const srv = servidorFalso([{ re: /.*/, fn: r }]);
        await assert.rejects(cliente(srv).consultarCliente('TESTE12345'), e => e.codigo === 'LOGIN_REQUIRED');
    }
    // Login cai só na consulta de status: também avisa (não vira Indeterminado).
    const srv = servidorFalso(rotasPadrao({ radius: () => resposta('', { status: 401 }) }));
    await assert.rejects(cliente(srv).consultarCliente('TESTE12345'), e => e.codigo === 'LOGIN_REQUIRED');
});

test('etiqueta não encontrada: tenta usuário PPPoE e IPoE e explica o motivo', async () => {
    const srv = servidorFalso(rotasPadrao({ lista: [linha({ serviceTag: 'TESTE123456' })] }));
    await assert.rejects(cliente(srv).consultarCliente('TESTE12345'), e => e.codigo === 'NAO_ENCONTRADO' && /1 resultado/.test(e.message));
    const filtros = srv.log.map(l => Object.keys(l.corpo).find(k => k.startsWith('filters[')));
    assert.deepEqual(filtros, ['filters[serviceTag]', 'filters[userName]', 'filters[userIpoe]']);
});

test('localiza pelo usuário PPPoE quando a etiqueta não bate', async () => {
    const rotas = rotasPadrao();
    rotas.unshift({ re: /connection\/json$/, metodo: 'POST', fn: (m, c) =>
        resposta({ data: c['filters[userName]'] ? [linha({ id: 4242, serviceTag: 'OUTRA', userPPPoE: 'joao.teste' })] : [] }) });
    const srv = servidorFalso(rotas);
    const d = await cliente(srv).consultarCliente('joao.teste');
    assert.equal(d.conexao.id, '4242');
    assert.equal(d.filtro, 'userName');
});

test('entradas inválidas são recusadas antes de qualquer requisição', async () => {
    const srv = servidorFalso(rotasPadrao());
    const c = cliente(srv);
    await assert.rejects(c.consultarCliente('<script>'), e => e.codigo === 'ENTRADA');
    await assert.rejects(c.consultarCliente(''), e => e.codigo === 'ENTRADA');
    await assert.rejects(c.buscarSplitters('a'), e => e.codigo === 'ENTRADA');
    await assert.rejects(c.buscarSplitters('x"; DROP'), e => e.codigo === 'ENTRADA');
    await assert.rejects(c.clientesDoSplitter('1 OR 1=1'), e => e.codigo === 'ENTRADA');
    await assert.rejects(c.statusConexao({ idConexao: '../../admin' }), e => e.codigo === 'ENTRADA');
    await assert.rejects(c._requisitar('/pt/admin/person'), e => e.codigo === 'ENTRADA');
    assert.equal(srv.log.length, 0);
    // Usuário com caracteres estranhos não é enviado ao RADIUS.
    const r = await c.statusConexao({ idConexao: '1', usuario: 'a b<script>' });
    assert.equal(r.estado, 'indeterminado');
    assert.ok(!srv.log.some(l => l.caminho.includes('connection-status')));
});

test('buscarSplitters envia a busca da Amigo e pagina', async () => {
    const srv = servidorFalso([{ re: /^\/pt\/autocompletefield\/select2ajax$/, metodo: 'POST', fn: (m, c) => {
        assert.equal(c.entity, core.ENTIDADE_CTO);
        assert.equal(c.columnName, 'cmCtoName');
        const base = (Number(c.page) - 1) * 10;
        return resposta(Array.from({ length: c.page === '1' ? 10 : 3 }, (_, i) => ({ id: base + i + 1, name: `CTO-${base + i + 1}-${c.q}`, total_count: 10 })));
    } }]);
    const c = cliente(srv);
    const p1 = await c.buscarSplitters('  CTO  centro ');
    assert.equal(srv.log[0].corpo.q, 'CTO centro');
    assert.equal(p1.itens.length, 10);
    assert.equal(p1.temMais, true);
    const p2 = await c.buscarSplitters('CTO centro', 2);
    assert.equal(p2.itens.length, 3);
    assert.equal(p2.temMais, false);
    assert.equal(await c.nomeSplitter('1001', '1'), 'CTO-1-CTO centro');
    assert.equal(srv.log.length, 2);
});

test('clientesDoSplitter filtra pelo ID do CTO e resume as linhas', async () => {
    const srv = servidorFalso([{ re: /connection\/json$/, metodo: 'POST', fn: (m, c) => {
        assert.equal(c['filters[splitter]'], '777');
        assert.equal(c['pagination[pageSize]'], '100');
        return resposta({ data: [linha({ id: 1 }), linha({ id: 2, status: 'Bloqueado', enabled: false }), linha({ id: null })], recordsTotal: 2 });
    } }]);
    const r = await cliente(srv).clientesDoSplitter(777);
    assert.equal(r.itens.length, 2);
    assert.equal(r.itens[0].usuarioPppoe, 'cliente.teste');
    assert.equal(r.itens[1].contrato, 'Bloqueado');
    assert.equal(r.itens[1].ativo, false);
});

// ------------------------------------------------------------
// AutoISP (dados da ONU já coletados)
// ------------------------------------------------------------

const AUTOISP = 'https://autoisp.brasiltecpar.com.br';
const CLIENTE_AUTOISP = { gpon_client_id: 742000, contracted_service_id: 358000, olt_hostname: 'OLT-TESTE-01', ponlink: '1/2/3',
    serial_number: 'ABCD00000001', conn_state: 'active', erp_id: 'TESTE12345', pppoe_username: 'cliente.teste' };
const EVENTOS = [
    { class: 'rx-ok', text: '-18.36 dBm', data: '2026-10-10T03:14:50.000Z', trigger: 'zabbix' },
    { class: 'up', text: 'UP', data: '2026-10-09T20:31:16.690Z', trigger: 'alarm' },
    { class: 'power-fail', text: 'Sem Energia', data: '2026-10-09T17:55:51.000Z', trigger: 'alarm' },
    { class: 'massive-power-fail', text: 'Massiva Energia', data: '2026-10-09T17:51:31.000Z', trigger: 'massive' }
];

const CADASTRO_AUTOISP = { conn_state: 'active', gpon_client: { id: 742000, onu: 11, service_port: 19020, vlan: 1514, description: 'CTO-TESTE - Porta 1' } };
const SESSAO_AUTOISP = { ip: '100.64.9.9', mac: 'aa:bb:cc:dd:ee:ff', username: 'cliente.teste', starttime: '2026-10-10T21:07:42.000Z', stoptime: null, sessiontime: 100 };

// Como o AutoISP real: erp_id exato e diferenciando maiúsculas.
// Trecho real (formato) da página HTML do serviço no AutoISP.
const PAGINA_SERVICO = '<div class="gpon-config-item"><b>Service Port</b><br />19020</div><div class="gpon-config-item"><b>CTO</b><br />CTO-TESTE-0060 - Porta 1 - NOT_SAN - Estimado</div>' +
    '<div class="gpon-config-item"><b>Perfil da ONU</b><br />HG6145F3</div><div class="gpon-config-item"><b>VLAN (do perfil)</b><br />1741</div>';

function autoispFalso({ busca = (q) => (q.erp_id === 'TESTE12345' ? [CLIENTE_AUTOISP] : []), eventos = () => EVENTOS,
    cadastro = () => CADASTRO_AUTOISP, sessao = () => SESSAO_AUTOISP, pagina = () => PAGINA_SERVICO,
    diagnostico = null, // null = tabela de diagnóstico indisponível (HTTP 404) → status pelo histórico
    urlFinal = null, status = 200 } = {}) {
    const log = [];
    const fetchFn = async (url, opcoes) => {
        const u = new URL(url);
        log.push(u.pathname + u.search);
        if (opcoes.signal && opcoes.signal.aborted) { const e = new Error('abort'); e.name = 'AbortError'; throw e; }
        if (status !== 200) return resposta('erro', { status, url: urlFinal || url });
        if (u.pathname === '/client_search/search') return resposta(busca(Object.fromEntries(u.searchParams)), { url: urlFinal || url });
        if (u.pathname === '/client_search/diagnostics_search') return diagnostico ? resposta(diagnostico(), { url }) : resposta('nada', { status: 404, url });
        const ou = (v, r) => (v === undefined ? resposta('erro', { status: 500, url }) : resposta(v, { url }));
        if (/\/last_status_changes$/.test(u.pathname)) return ou(eventos(), r => r);
        if (/^\/contracted_services\/\d+\.json$/.test(u.pathname)) return ou(cadastro());
        if (/^\/contracted_services\/\d+$/.test(u.pathname)) { const p = pagina(); return p === undefined ? resposta('erro', { status: 500, url }) : resposta(p, { url }); }
        if (/\/l3_informations$/.test(u.pathname)) return ou(sessao());
        return resposta('nada', { status: 404, url });
    };
    return { fetchFn, log };
}

// ---------- Status atual (tabela de diagnóstico do AutoISP), formato real medido em 11/10/2026 ----------

const DIAG_OK = {
    cto_description: 'CTO-SPG-0142', erp_id: 'TESTE12345', gpon_client_id: 742000, olt_hostname: 'OLT-TESTE-01', olt_id: 193,
    olt_rx_power: '-23.56', onu: 13, onu_distance: 2040, onu_last_off: '2026-10-11T12:54:13Z', onu_olt_description: 'FULANO DE TESTE',
    onu_rx_power: '-18.23', onu_status: 'OK', onu_status_updated_at: '2026-07-29T12:30:25Z', ponlink: '2/5', serial_number: '50524B5300CC82BB'
};
const DIAG_LOS = { ...DIAG_OK, olt_rx_power: null, onu_rx_power: '0.0', onu_status: 'loss_signal', onu_last_off: '2026-10-09T23:00:12Z', onu_status_updated_at: '2026-10-09T23:00:11Z' };

/** Como o AutoISP real: 1ª chamada "enqueued", a seguinte traz o resultado. */
function diagnosticoReal(linha) {
    let n = 0;
    return () => (n++ === 0 ? { uuid: '00000000-0000-0000-0000-000000000000', status: 'enqueued', response: {} } : [linha]);
}

test('interpretarDiagnostico: OK, LOS, Down e sem dado', () => {
    const ok = core.interpretarDiagnostico(DIAG_OK);
    assert.equal(ok.estado, 'online');
    assert.equal(ok.problema, null);
    assert.equal(ok.texto, 'Online (OK)');
    assert.equal(ok.rxOnu, '-18.23 dBm');
    assert.equal(ok.rxOlt, '-23.56 dBm');
    assert.equal(ok.sinal.classificacao.rotulo, 'Bom');
    assert.equal(ok.sinal.atual, true);
    assert.equal(ok.distancia, '2,04 km');
    assert.equal(ok.cto, 'CTO-SPG-0142');
    const los = core.interpretarDiagnostico(DIAG_LOS);
    assert.equal(los.estado, 'offline');
    assert.equal(los.problema, 'los');
    assert.equal(los.texto, 'LOS (sem sinal óptico)');
    assert.equal(los.rxOnu, '');   // "0.0" de ONU caída não é sinal
    assert.equal(los.sinal, null);
    assert.equal(core.interpretarDiagnostico({ ...DIAG_OK, onu_status: 'down' }).problema, 'down');
    assert.equal(core.interpretarDiagnostico({ ...DIAG_OK, onu_status: 'massive_loss_signal' }).problema, 'massiva-los');
    assert.equal(core.interpretarDiagnostico({ ...DIAG_OK, onu_status: 'power_fail' }).problema, 'dgi');
    assert.equal(core.interpretarDiagnostico({ ...DIAG_OK, onu_status: 'unavailable' }).problema, 'indisponivel');
    assert.equal(core.interpretarDiagnostico({ ...DIAG_OK, onu_status: null }).estado, 'desconhecido');
    // Caso do vídeo de 13/10/2026: "warning" é ONU UP com sinal fraco, não "Down"
    const fraco = core.interpretarDiagnostico({ ...DIAG_OK, onu_status: 'warning', onu_rx_power: '-26.58', olt_rx_power: '-24.69' });
    assert.equal(fraco.estado, 'online');
    assert.equal(fraco.problema, null);
    assert.equal(fraco.texto, 'Online (sinal atenção)');
    assert.equal(fraco.sinal.classificacao.rotulo, 'Atenção');
    assert.equal(fraco.rxOlt, '-24.69 dBm');
    assert.equal(core.interpretarDiagnostico({ ...DIAG_OK, onu_status: 'critical' }).estado, 'online');
    assert.equal(core.interpretarDiagnostico({ ...DIAG_OK, onu_status: 'rx_warning' }).estado, 'online');
    // Valor desconhecido: não inventa queda (o histórico decide)
    assert.equal(core.interpretarDiagnostico({ ...DIAG_OK, onu_status: 'algo_novo' }).estado, 'desconhecido');
    assert.equal(core.mesclarStatusAtual(core.resumirEventosOnu([{ class: 'up', text: 'UP', data: '2026-10-12T13:15:11Z' }]),
        core.interpretarDiagnostico({ ...DIAG_OK, onu_status: 'algo_novo' })).statusOnu.estado, 'online');
    assert.equal(core.interpretarDiagnostico(null), null);
});

test('mesclarStatusAtual: histórico com LOS antigo + status atual OK = ONLINE (caso do vídeo de 11/10/2026)', () => {
    const historico = core.resumirEventosOnu([{ class: 'loss-signal', text: 'LOS', data: '2026-07-03T12:27:00Z' },
        { class: 'rx-ok', text: '-23.87 dBm', data: '2026-08-31T19:07:00Z' }]);
    assert.equal(historico.statusOnu.problema, 'los'); // o que a versão anterior mostrava
    const r = core.mesclarStatusAtual(historico, core.interpretarDiagnostico(DIAG_OK));
    assert.equal(r.statusOnu.estado, 'online');
    assert.equal(r.statusOnu.problema, null);
    assert.equal(r.statusOnu.fonte, 'status');
    assert.equal(r.sinal.texto, '-18.23 dBm'); // sinal atual, não a leitura de 31/08
    assert.equal(r.ultimaQueda.texto, 'LOS');  // continua como histórico
    // Status atual indisponível ou sem dado: vale o histórico
    assert.equal(core.mesclarStatusAtual(historico, null).statusOnu.problema, 'los');
    assert.equal(core.mesclarStatusAtual(historico, { estado: 'desconhecido' }).statusOnu.problema, 'los');
    // Status atual LOS: problema atual, desde o último desligamento
    const caido = core.mesclarStatusAtual(core.resumirEventosOnu([]), core.interpretarDiagnostico(DIAG_LOS));
    assert.equal(caido.statusOnu.problema, 'los');
    assert.equal(caido.statusOnu.quando, '2026-10-09T23:00:12Z');
});

test('camposPaginaServico', () => {
    assert.deepEqual(core.camposPaginaServico(PAGINA_SERVICO), { vlanPerfil: '1741', cto: 'CTO-TESTE-0060 - Porta 1 - NOT_SAN - Estimado', perfilOnu: 'HG6145F3' });
    assert.deepEqual(core.camposPaginaServico('<b>CTO</b><br /></div>'), { vlanPerfil: '', cto: '', perfilOnu: '' });
});

test('lerDiagnostico: repete a chamada até sair do "enqueued" e usa exatamente as colunas da tela', async () => {
    const srv = autoispFalso({ diagnostico: diagnosticoReal(DIAG_OK) });
    const c = core.criarClienteAutoIsp({ fetchFn: srv.fetchFn, esperar: () => Promise.resolve() });
    const d = await c._lerDiagnostico('TESTE12345');
    assert.equal(d.estado, 'online');
    const chamadas = srv.log.filter(p => p.startsWith('/client_search/diagnostics_search'));
    assert.equal(chamadas.length, 2);
    const q = new URL(AUTOISP + chamadas[0]).searchParams;
    assert.equal(q.get('erp_id'), 'TESTE12345');
    assert.equal(q.get('topology'), 'ftth');
    assert.match(q.get('columns'), /^erp_id,gpon_client_id,olt_id,ponlink,onu,serial_number,onu_rx_power,olt_rx_power,onu_status_updated_at,onu_last_off/);
    // Nunca sai do "enqueued": desiste com TIMEOUT
    const preso = autoispFalso({ diagnostico: () => ({ status: 'enqueued' }) });
    await assert.rejects(core.criarClienteAutoIsp({ fetchFn: preso.fetchFn, esperar: () => Promise.resolve() })._lerDiagnostico('TESTE12345'), e => e.codigo === 'TIMEOUT');
    // Resultado sem a etiqueta pedida
    const outro = autoispFalso({ diagnostico: () => [{ ...DIAG_OK, erp_id: 'OUTRO' }] });
    await assert.rejects(core.criarClienteAutoIsp({ fetchFn: outro.fetchFn })._lerDiagnostico('TESTE12345'), e => e.codigo === 'NAO_ENCONTRADO');
});

test('consultarOnu com status atual: LOS antigo no histórico não vira problema quando o AutoISP diz OK', async () => {
    const srv = autoispFalso({ eventos: () => [{ class: 'loss-signal', text: 'LOS', data: '2026-07-03T12:27:00Z' }], sessao: () => ({}), diagnostico: diagnosticoReal(DIAG_OK) });
    const o = await core.criarClienteAutoIsp({ fetchFn: srv.fetchFn, esperar: () => Promise.resolve() }).consultarOnu('TESTE12345');
    assert.equal(o.statusOnu.estado, 'online');
    assert.equal(o.statusOnu.problema, null);
    assert.equal(o.statusOnu.fonte, 'status');
    assert.equal(o.statusAtual.rxOlt, '-23.56 dBm');
    assert.equal(o.statusAtualErro, '');
    assert.equal(o.ultimaQueda.texto, 'LOS');
    // E ao contrário: AutoISP diz LOS agora → problema atual
    const o2 = await core.criarClienteAutoIsp({ fetchFn: autoispFalso({ diagnostico: diagnosticoReal(DIAG_LOS) }).fetchFn, esperar: () => Promise.resolve() }).consultarOnu('TESTE12345');
    assert.equal(o2.statusOnu.problema, 'los');
    // Tabela indisponível: usa o histórico e mostra o motivo
    const o3 = await core.criarClienteAutoIsp({ fetchFn: autoispFalso().fetchFn }).consultarOnu('TESTE12345');
    assert.match(o3.statusAtualErro, /HTTP 404/);
    assert.equal(o3.statusOnu.fonte, undefined);
    // VLAN: cadastro vazio → a do perfil
    const o4 = await core.criarClienteAutoIsp({ fetchFn: autoispFalso({ cadastro: () => ({ gpon_client: { onu: 3, vlan: null } }) }).fetchFn }).consultarOnu('TESTE12345');
    assert.equal(o4.vlan, '1741');
});

test('"Ler agora na OLT": pede refresh_status, espera e relê o status atual', async () => {
    const srv = autoispFalso({ diagnostico: diagnosticoReal(DIAG_OK) });
    const esperas = [];
    const c = core.criarClienteAutoIsp({ fetchFn: srv.fetchFn, esperar: ms => { esperas.push(ms); return Promise.resolve(); } });
    const o = await c.consultarOnu('TESTE12345', null, { aoVivo: true });
    assert.equal(o.statusOnu.estado, 'online');
    const iRefresh = srv.log.findIndex(p => p.startsWith('/gpon_clients/742000/refresh_status.json'));
    const iDiag = srv.log.findIndex(p => p.startsWith('/client_search/diagnostics_search'));
    assert.ok(iRefresh >= 0 && iRefresh < iDiag, 'refresh antes da leitura do status');
    assert.ok(esperas.includes(15000), 'aguarda a leitura da OLT');
});

test('resumirEventosOnu: status atual, último sinal e última queda', () => {
    const r = core.resumirEventosOnu(EVENTOS);
    assert.equal(r.statusOnu.estado, 'online');
    assert.equal(r.statusOnu.texto, 'Online (UP)');
    assert.equal(r.sinal.valor, -18.36);
    assert.equal(r.sinal.classificacao.rotulo, 'Bom');
    assert.equal(r.ultimaQueda.texto, 'Sem Energia');
    assert.equal(r.eventos.length, 3);
    // Ordem bagunçada e ONU caída por último
    const caida = core.resumirEventosOnu([EVENTOS[1], { class: 'los', text: 'LOS', data: '2026-10-10T05:00:00Z' }, EVENTOS[0]]);
    assert.equal(caida.statusOnu.estado, 'offline');
    assert.equal(caida.statusOnu.texto, 'LOS (sem sinal óptico)');
    assert.equal(caida.statusOnu.problema, 'los');
    assert.equal(core.resumirEventosOnu([]).statusOnu.estado, 'desconhecido');
    assert.equal(core.resumirEventosOnu(null).sinal, null);
});

test('classificarSinal segue as faixas GPON', () => {
    assert.equal(core.classificarSinal(-18).rotulo, 'Bom');
    assert.equal(core.classificarSinal(-26).rotulo, 'Atenção');
    assert.equal(core.classificarSinal(-29).rotulo, 'Crítico');
    assert.equal(core.classificarSinal(-5).rotulo, 'Saturado');
    assert.equal(core.classificarSinal(NaN), null);
});

test('consultarOnu: acha pelo ERP ID e monta o resumo com ID da ONU, IP e link direto', async () => {
    const srv = autoispFalso();
    const o = await core.criarClienteAutoIsp({ abrirWebSocket: null, fetchFn: srv.fetchFn }).consultarOnu('teste12345');
    assert.equal(o.encontradoPor, 'erp_id');
    assert.equal(o.gponId, '742000');
    assert.equal(o.olt, 'OLT-TESTE-01');
    assert.equal(o.onuId, '11');
    assert.equal(o.servicePort, '19020');
    assert.equal(o.vlan, '1514');
    assert.equal(o.descricaoOlt, 'CTO-TESTE - Porta 1');
    assert.equal(o.sessao.ip, '100.64.9.9');
    assert.equal(o.sessao.mac, 'AA:BB:CC:DD:EE:FF');
    assert.equal(o.sessao.fim, '');
    assert.equal(o.link, AUTOISP + '/contracted_services/358000');
    assert.equal(o.statusOnu.estado, 'online');
    assert.equal(o.statusOnu.problema, null);
    assert.equal(o.sinal.texto, '-18.36 dBm');
    assert.equal(o.sinal.classificacao.rotulo, 'Bom');
    assert.equal(o.cto, 'CTO-TESTE-0060 - Porta 1 - NOT_SAN - Estimado');
    assert.equal(o.perfilOnu, 'HG6145F3');
    assert.equal(srv.log.length, 6); // busca, tabela de diagnóstico, histórico, cadastro, página do serviço, sessão
    assert.ok(srv.log.every(p => /^\/(client_search\/(search|diagnostics_search)|gpon_clients\/\d+\/(last_status_changes|l3_informations)|contracted_services\/\d+(\.json)?$)/.test(p.split('?')[0])),
        'só endpoints de leitura');
});

test('consultarOnu: cadastro, sessão ou histórico indisponíveis não derrubam o resto', async () => {
    const srv = autoispFalso({ cadastro: () => undefined, sessao: () => undefined });
    const o = await core.criarClienteAutoIsp({ abrirWebSocket: null, fetchFn: srv.fetchFn }).consultarOnu('TESTE12345');
    assert.equal(o.onuId, '');
    assert.equal(o.sessao.ip, '');
    assert.equal(o.statusOnu.estado, 'online');
    const srv2 = autoispFalso({ eventos: () => undefined });
    const o2 = await core.criarClienteAutoIsp({ abrirWebSocket: null, fetchFn: srv2.fetchFn }).consultarOnu('TESTE12345');
    assert.equal(o2.statusOnu.estado, 'online'); // sem histórico, mas com sessão ativa
    assert.equal(o2.statusOnu.texto, 'Online (sessão ativa)');
    assert.equal(o2.onuId, '11');
    const srv3 = autoispFalso({ eventos: () => undefined, sessao: () => undefined });
    assert.equal((await core.criarClienteAutoIsp({ abrirWebSocket: null, fetchFn: srv3.fetchFn }).consultarOnu('TESTE12345')).statusOnu.estado, 'desconhecido');
});

test('tipoProblema: LOS, DGI (Sem Energia), massiva e Down', () => {
    assert.equal(core.tipoProblema('loss-signal', 'LOS'), 'los');
    assert.equal(core.tipoProblema('power-fail', 'Sem Energia'), 'dgi');
    assert.equal(core.tipoProblema('dying-gasp', 'DGI'), 'dgi');
    assert.equal(core.tipoProblema('massive-power-fail', 'Massiva Energia'), 'massiva');
    assert.equal(core.tipoProblema('massive-loss-signal', 'Massiva LOS'), 'massiva-los'); // classe real
    assert.equal(core.tipoProblema('unavailable', 'Não Disponível'), 'indisponivel'); // classe real
    assert.equal(core.tipoProblema('down', 'Down'), 'down');
    assert.equal(core.tipoProblema('alguma-coisa-nova', 'Offline'), 'down');
    assert.equal(core.tipoProblema('up', 'UP'), null);
    const r = core.resumirEventosOnu([{ class: 'loss-signal', text: 'LOS', data: '2026-10-11T10:00:00Z' }, EVENTOS[1]]);
    assert.equal(r.statusOnu.problema, 'los');
    assert.equal(r.statusOnu.texto, 'LOS (sem sinal óptico)');
    const dgi = core.resumirEventosOnu([{ class: 'power-fail', text: 'Sem Energia', data: '2026-10-11T10:00:00Z' }]);
    assert.equal(dgi.statusOnu.texto, 'Sem energia (DGI)');
});

test('corrigirPelaSessao: LOS antigo + sessão ativa mais nova = online (caso real de 11/10/2026)', () => {
    const los = core.resumirEventosOnu([{ class: 'loss-signal', text: 'LOS', data: '2026-07-28T10:49:00Z' }]);
    const sessaoAtiva = { ip: '100.64.1.1', starttime: '2026-10-11T12:43:00Z', stoptime: null };
    const r = core.corrigirPelaSessao(los, sessaoAtiva);
    assert.equal(r.statusOnu.estado, 'online');
    assert.equal(r.statusOnu.problema, null);
    assert.equal(r.ultimaQueda.texto, 'LOS'); // continua como histórico
    // Queda DEPOIS do início da sessão: o problema vale
    const losNovo = core.resumirEventosOnu([{ class: 'loss-signal', text: 'LOS', data: '2026-10-11T13:00:00Z' }]);
    assert.equal(core.corrigirPelaSessao(losNovo, sessaoAtiva).statusOnu.problema, 'los');
    // Sessão encerrada ou sem IP: não corrige
    assert.equal(core.corrigirPelaSessao(los, { ...sessaoAtiva, stoptime: '2026-10-11T13:00:00Z' }).statusOnu.problema, 'los');
    assert.equal(core.corrigirPelaSessao(los, { starttime: '2026-10-11T12:43:00Z' }).statusOnu.problema, 'los');
    assert.equal(core.corrigirPelaSessao(los, null).statusOnu.problema, 'los');
});

test('consultarOnu aplica a correção pela sessão', async () => {
    const srv = autoispFalso({
        eventos: () => [{ class: 'loss-signal', text: 'LOS', data: '2026-07-28T10:49:00Z' }],
        sessao: () => ({ ...SESSAO_AUTOISP, starttime: '2026-10-11T12:43:00Z', stoptime: null })
    });
    const o = await core.criarClienteAutoIsp({ abrirWebSocket: null, fetchFn: srv.fetchFn }).consultarOnu('TESTE12345');
    assert.equal(o.statusOnu.estado, 'online');
    assert.equal(o.statusOnu.problema, null);
});

test('sinal: usa a classificação do AutoISP (rx-warning/rx-critical) antes das faixas próprias', () => {
    const w = core.resumirEventosOnu([{ class: 'rx-warning', text: '-24.10 dBm', data: '2026-10-11T10:00:00Z' }]);
    assert.equal(w.sinal.classificacao.rotulo, 'Atenção'); // pelas faixas seria "Bom"
    const c = core.resumirEventosOnu([{ class: 'rx-critical', text: '-27.50 dBm', data: '2026-10-11T10:00:00Z' }]);
    assert.equal(c.sinal.classificacao.rotulo, 'Crítico');
    const x = core.resumirEventosOnu([{ class: 'rx-novo', text: '-29.00 dBm', data: '2026-10-11T10:00:00Z' }]);
    assert.equal(x.sinal.classificacao.rotulo, 'Crítico'); // classe desconhecida → faixas próprias
});

test('consultarOnu: não achou pelo ERP ID → tenta usuário PPPoE e depois a etiqueta como usuário', async () => {
    const srv = autoispFalso({ busca: q => (q.pppoe_username === 'cliente.teste' ? [CLIENTE_AUTOISP] : []) });
    const o = await core.criarClienteAutoIsp({ abrirWebSocket: null, fetchFn: srv.fetchFn }).consultarOnu('outra1', 'cliente.teste');
    assert.equal(o.encontradoPor, 'pppoe_username');
    assert.deepEqual(srv.log.slice(0, 3).map(p => new URL(AUTOISP + p).searchParams.toString()),
        ['erp_id=OUTRA1', 'erp_id=outra1', 'pppoe_username=cliente.teste']);

    const srv2 = autoispFalso({ busca: () => [{ ...CLIENTE_AUTOISP, erp_id: 'TESTE123456', pppoe_username: 'outro' }] }); // só "parecido"
    await assert.rejects(core.criarClienteAutoIsp({ abrirWebSocket: null, fetchFn: srv2.fetchFn }).consultarOnu('TESTE12345'), e => e.codigo === 'NAO_ENCONTRADO');
    assert.equal(srv2.log.length, 2, 'erp_id + pppoe_username=etiqueta');
});

test('consultarOnu: cache de 2 min e uma consulta só para pedidos iguais simultâneos', async () => {
    let agora = 1_000_000;
    const srv = autoispFalso();
    const c = core.criarClienteAutoIsp({ abrirWebSocket: null, fetchFn: srv.fetchFn, agora: () => agora });
    await Promise.all([c.consultarOnu('TESTE12345'), c.consultarOnu('teste12345')]);
    assert.equal(srv.log.length, 6);
    assert.equal((await c.consultarOnu('TESTE12345')).doCache, true);
    agora += 121_000;
    await c.consultarOnu('TESTE12345');
    assert.equal(srv.log.length, 12);
});

test('consultarOnu: sem login, erro de rede e endereço não permitido', async () => {
    const login = autoispFalso({ urlFinal: AUTOISP + '/users/sign_in' });
    await assert.rejects(core.criarClienteAutoIsp({ abrirWebSocket: null, fetchFn: login.fetchFn }).consultarOnu('TESTE12345'), e => e.codigo === 'LOGIN_AUTOISP');
    const html = { fetchFn: async (url) => resposta('<html>login</html>', { url }) };
    await assert.rejects(core.criarClienteAutoIsp({ abrirWebSocket: null, fetchFn: html.fetchFn }).consultarOnu('TESTE12345'), e => e.codigo === 'LOGIN_AUTOISP');
    const rede = { fetchFn: async () => { throw new TypeError('Failed to fetch'); } };
    await assert.rejects(core.criarClienteAutoIsp({ abrirWebSocket: null, fetchFn: rede.fetchFn }).consultarOnu('TESTE12345'), e => e.codigo === 'REDE');
    const lento = { fetchFn: (url, o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => { const e = new Error('a'); e.name = 'AbortError'; rej(e); })) };
    await assert.rejects(core.criarClienteAutoIsp({ abrirWebSocket: null, fetchFn: lento.fetchFn, tempoMs: 20 }).consultarOnu('TESTE12345'), e => e.codigo === 'TIMEOUT');
    const c = core.criarClienteAutoIsp({ abrirWebSocket: null, fetchFn: autoispFalso().fetchFn });
    await assert.rejects(c._requisitar('/acs_clients/1/refresh_client'), e => e.codigo === 'ENTRADA');
    await assert.rejects(c._requisitar('/gpon_clients/1/onu_reset'), e => e.codigo === 'ENTRADA');
    await assert.rejects(c._requisitar('/gpon_clients/1/onu_info.json'), e => e.codigo === 'ENTRADA'); // leitura ao vivo na OLT
    await assert.rejects(c._requisitar('/contracted_services/1/edit'), e => e.codigo === 'ENTRADA');
    await assert.rejects(c._requisitar('/gpon_clients/1/create_pots_config'), e => e.codigo === 'ENTRADA');
    await assert.rejects(c._requisitar('/alerts/1'), e => e.codigo === 'ENTRADA');
    await assert.rejects(c.consultarOnu('<script>'), e => e.codigo === 'ENTRADA');
});

test('nomeSplitter lê a página /edit com prioridade baixa e guarda em cache', async () => {
    const srv = servidorFalso([{ re: /\/connection\/(\d+)\/edit$/, fn: () => resposta("x new Option('CTO-777-TESTE', '777', false, false) y") }]);
    const c = cliente(srv);
    assert.equal(await c.nomeSplitter('1001', '777'), 'CTO-777-TESTE');
    assert.equal(await c.nomeSplitter('1002', '777'), 'CTO-777-TESTE');
    assert.equal(srv.log.length, 1);
});

// ------------------------------------------------------------
// Abordagem (Amigo × AutoISP) — HTML no formato real da página /edit (medido em 06/11/2026), dados FICTÍCIOS
// ------------------------------------------------------------

// Slot/Porta sem Splitter: a Amigo não põe no value; preenche por script (formato real medido em 26/11/2026).
const EDICAO = ({ onuId = '', onuSn = '', tec = '3', semAp = false, slot = '', porta = '' } = {}) => `
<script>$('#connection_slotOltFake').val(''); $('#connection_portOltFake').val(''); $('#connection_idOnuFake').val('');</script>
${slot ? `<script>$('#connection_slotOltFake').val('${slot}'); $('#connection_portOltFake').val('${porta}');</script>` : ''}
<form method="post" action="/pt/network-documentation/connection/1001/edit">
<input type="text" id="connection_serviceTag" name="connection[serviceTag]" required="required" class="form-control" maxlength="255" value="TESTE12345" />
<select id="connectionApproach_technologyType" name="connectionApproach[0][technologyType]" class="form-control technologyType">
${[['2', 'Spread Spectrum'], ['3', 'FTTH'], ['4', 'HFC']].map(([v, t]) => `<option value="${v}" ${v === tec ? 'selected' : ''}>${t}</option>`).join('')}
</select>
<input type="text" id="connectionApproach_onuId" name="connectionApproach[0][onuId]" value="${onuId}" class="form-control"/>
<input type="text" id="connectionApproach_onuSn" name="connectionApproach[0][onuSn]" value="${onuSn}" class="form-control" />
<input type="text" id="connectionApproach_userPPPoE" name="connectionApproach[0][userPPPoE]" value="cliente.teste" class="form-control" />
<input type="text" id="connectionApproach_vlan_0" name="connectionApproach[0][vlan]" value="1000" class="form-control" />
</form>
<script>${semAp ? '' : "$('#ap').append(new Option('OLT-TESTE-01', '22271', true, true));"}</script>`;

const ONU_TESTE = { olt: 'OLT-TESTE-01', ponlink: '1/1/7', onuId: '114', serial: '485754430FBB1630' };

test('lerAbordagemDaEdicao: tecnologia selecionada, ID ONU, serial e campos de controle', () => {
    const a = core.lerAbordagemDaEdicao(EDICAO({ onuId: '114', onuSn: 'HWTC0FBB1630' }));
    assert.deepEqual(a.tecnologia, { valor: '3', texto: 'FTTH' });
    assert.equal(a.onuId, '114');
    assert.equal(a.onuSn, 'HWTC0FBB1630');
    assert.equal(a.controle.etiqueta, 'TESTE12345');
    assert.equal(a.controle.usuarioPppoe, 'cliente.teste');
    assert.equal(a.controle.selecionados, '22271');
    // Sem "selected": vale a primeira opção (é o que o navegador mostra e a Amigo grava).
    assert.equal(core.lerAbordagemDaEdicao(EDICAO({ tec: 'nenhum' })).tecnologia.texto, 'Spread Spectrum');
    // Página sem os campos (login, erro, layout novo): erro claro, nunca "tudo vazio".
    assert.throws(() => core.lerAbordagemDaEdicao('<html>outra página</html>'), e => e.codigo === 'FORMATO');
});

test('normalizarSerial e slotPortaDoPon', () => {
    assert.equal(core.normalizarSerial('485754430FBB1630'), 'HWTC0FBB1630');
    assert.equal(core.normalizarSerial('hwtc-0fbb1630'), 'HWTC0FBB1630');
    assert.equal(core.normalizarSerial('ZTEGC0FFEE01'), 'ZTEGC0FFEE01');
    assert.deepEqual(core.slotPortaDoPon('1/1/7'), { slot: '1', porta: '7' });
    assert.deepEqual(core.slotPortaDoPon('2/5'), { slot: '2', porta: '5' });
    assert.equal(core.slotPortaDoPon(''), null);
    assert.equal(core.slotPortaDoPon('1/x/7'), null);
});

test('compararAbordagem: sem Splitter, Slot/Porta/ID ONU/Serial vazios viram "faltando" e entram no preenchimento', () => {
    const ab = core.lerAbordagemDaEdicao(EDICAO());
    const r = core.compararAbordagem(ab, { ctoId: null, slot: null, porta: null }, ONU_TESTE);
    const est = Object.fromEntries(r.itens.map(i => [i.campo, i.estado]));
    // Serial fica fora da conferência e do preenchimento (pedido do usuário).
    assert.deepEqual(est, { tecnologia: 'ok', slot: 'faltando', porta: 'faltando', onuId: 'faltando' });
    // PON Link "1/1/7" → Slot 1, Porta 7.
    assert.deepEqual(r.preencher, { slot: '1', porta: '7', onuId: '114' });
    assert.equal(r.totalPreencher, 3);
    assert.equal(r.completo, false);
    // Com Splitter, Slot/Porta vazios vêm da CTO: nunca são preenchidos pela extensão.
    const comCto = core.compararAbordagem(ab, { ctoId: '777', slot: null, porta: null }, ONU_TESTE);
    assert.equal(comCto.itens.find(i => i.campo === 'slot').estado, 'depende-splitter');
    assert.equal(comCto.preencher.slot, undefined);
});

test('lerAbordagemDaEdicao + compararAbordagem: Slot/Porta gravados sem Splitter vêm do script da página', () => {
    const ab = core.lerAbordagemDaEdicao(EDICAO({ slot: '1', porta: '7' }));
    assert.equal(ab.slot, '1');
    assert.equal(ab.porta, '7');
    assert.equal(core.lerAbordagemDaEdicao(EDICAO()).slot, ''); // só os .val('') de limpeza: vazio
    const r = core.compararAbordagem(ab, { ctoId: null, slot: null, porta: null }, ONU_TESTE);
    assert.equal(r.itens.find(i => i.campo === 'slot').estado, 'ok');
    assert.equal(r.itens.find(i => i.campo === 'porta').estado, 'ok');
    assert.equal(r.preencher.slot, undefined);
    const outra = core.compararAbordagem(core.lerAbordagemDaEdicao(EDICAO({ slot: '4', porta: '11' })), {}, ONU_TESTE);
    assert.equal(outra.itens.find(i => i.campo === 'porta').estado, 'divergente'); // nunca trocado, só avisa
});

test('compararAbordagem: valor já preenchido nunca é trocado; diferente vira "divergente"', () => {
    const ab = core.lerAbordagemDaEdicao(EDICAO({ onuId: '99', onuSn: 'HWTC0FBB1630', tec: '2' }));
    const r = core.compararAbordagem(ab, { ctoId: '777', slot: '1', porta: '8' }, ONU_TESTE);
    const est = Object.fromEntries(r.itens.map(i => [i.campo, i.estado]));
    assert.deepEqual(est, { tecnologia: 'divergente', slot: 'ok', porta: 'divergente', onuId: 'divergente' });
    assert.deepEqual(r.preencher, {});
    assert.equal(r.divergentes, 3);
});

test('compararAbordagem: tudo certo = completo; sem ONU no AutoISP = nada a preencher', () => {
    const ab = core.lerAbordagemDaEdicao(EDICAO({ onuId: '114', onuSn: '485754430FBB1630' }));
    const ok = core.compararAbordagem(ab, { ctoId: '777', slot: '1', porta: '7' }, ONU_TESTE);
    assert.equal(ok.completo, true);
    assert.equal(ok.totalPreencher, 0);
    const semOnu = core.compararAbordagem(core.lerAbordagemDaEdicao(EDICAO()), {}, null);
    assert.equal(semOnu.temOnu, false);
    assert.equal(semOnu.totalPreencher, 0);
    assert.ok(semOnu.itens.filter(i => i.campo === 'onuId').every(i => i.estado === 'sem-dado'));
    assert.ok(!semOnu.itens.some(i => i.campo === 'onuSn'));
    // Preenchido na Amigo e o AutoISP sem o dado: "preenchido" (sem conferência), não "igual".
    assert.equal(core.compararAbordagem(ab, {}, { olt: 'X' }).itens.find(i => i.campo === 'onuId').estado, 'preenchido');
    // Valores inválidos do AutoISP não são preenchidos.
    const inval = core.compararAbordagem(core.lerAbordagemDaEdicao(EDICAO()), {}, { ...ONU_TESTE, onuId: '12a', serial: 'x<1>', ponlink: '1/x/7' });
    assert.deepEqual(inval.preencher, {});
});

test('abordagem(): lê a /edit uma vez (cache curto, compartilhado com o nome do splitter) e forcar relê', async () => {
    const srv = servidorFalso([{ re: /\/connection\/(\d+)\/edit$/, fn: () => resposta(EDICAO({ onuId: '114' })) }]);
    const c = cliente(srv);
    assert.equal((await c.abordagem('1001')).onuId, '114');
    await c.abordagem('1001');
    assert.equal(srv.log.length, 1);
    await c.abordagem('1001', { forcar: true });
    assert.equal(srv.log.length, 2);
    await assert.rejects(c.abordagem('abc'), e => e.codigo === 'ENTRADA');
});

test('consultarOnu: busca sem filtro de situação e prefere a ONU provisionada (cliente bloqueado aparece)', async () => {
    const bloqueado = { ...CLIENTE_AUTOISP, conn_state: 'blocked' };
    const cancelado = { ...CLIENTE_AUTOISP, conn_state: 'canceled', serial_number: '', olt_hostname: null, gpon_client_id: 1 };
    const srv = autoispFalso({ busca: q => (q.erp_id === 'TESTE12345' && !q.conn_state ? [cancelado, bloqueado] : []) });
    const o = await core.criarClienteAutoIsp({ fetchFn: srv.fetchFn }).consultarOnu('TESTE12345');
    assert.equal(o.serial, CLIENTE_AUTOISP.serial_number);
    assert.equal(o.gponId, String(CLIENTE_AUTOISP.gpon_client_id));
});

// ------------------------------------------------------------
// IP da OLT (AutoISP) e do Ponto de acesso / uPE (Amigo) — formatos reais medidos em 10/11/2026, dados fictícios
// ------------------------------------------------------------

const PAGINA_ATIVOS = `<script>var oTable = $('#tabela_default').DataTable({
    "ajax": { url: "//plataforma.sejaamigo.com.br:443/datatables/default", type: "POST",
        data: function (d) { d.idColumn = "id"; d.columns = "aWQsIG5hbWU="; d.getColumns = "SWQsIE5hbWU="; d.entity = "QXBwXEVudGl0eQ==";
            d.route = "company_network_documentation_actives"; d.crud = "QywgVSwgRA=="; d.tableJoin = "QXBw"; d.idJoinColumn = "aWQ=";
            if (!$.isEmptyObject(advancedSearch)) { d.searchColumn = advancedSearch.i; } } } });</script>`;
const LINHA_ATIVO = (nome, ip, id = '900') => [`<span idRow="${id}">${id}</span>`, id, '95000', nome, 'uPE', 'OLT', ip, 'SITE-TESTE', 'Sim'];

test('parametrosTabelaAtivos: lê os parâmetros do DataTables da própria página', () => {
    const p = core.parametrosTabelaAtivos(PAGINA_ATIVOS);
    assert.deepEqual(Object.keys(p), ['idColumn', 'columns', 'getColumns', 'entity', 'route', 'crud', 'tableJoin', 'idJoinColumn']);
    assert.equal(p.route, 'company_network_documentation_actives');
    assert.throws(() => core.parametrosTabelaAtivos('<html>sem tabela</html>'), e => e.codigo === 'FORMATO');
});

test('ipDaTabelaAtivos: nome exato (a busca é "contém") e IP válido', () => {
    const json = { data: [LINHA_ATIVO('OLT-TESTE-01-CE01', '10.0.0.9'), LINHA_ATIVO('OLT-TESTE-01', '10.0.0.5', '901')] };
    assert.deepEqual(core.ipDaTabelaAtivos(json, 'olt-teste-01'), { ip: '10.0.0.5', id: '901', funcao: 'uPE', categoria: 'OLT' });
    assert.equal(core.ipDaTabelaAtivos(json, 'OLT-OUTRA'), null);
    assert.equal(core.ipDaTabelaAtivos({ data: [LINHA_ATIVO('OLT-X', '<b>1.2.3</b>')] }, 'OLT-X'), null);
    assert.equal(core.ipDaTabelaAtivos(null, 'OLT-X'), null);
});

test('ipDaListaOlts: OLT pelo ID com IP válido', () => {
    const json = { olts: [{ id: 2, hostname: 'OLT-TESTE-02', ip: '10.1.2.3', model: 'Huawei MA5600T' }], total_count: 1 };
    assert.deepEqual(core.ipDaListaOlts(json, '2'), { ip: '10.1.2.3', hostname: 'OLT-TESTE-02', modelo: 'Huawei MA5600T' });
    assert.equal(core.ipDaListaOlts(json, '3'), null);
    assert.equal(core.ipDaListaOlts({ olts: [{ id: 2, ip: '999.1.1.1' }] }, '2'), null);
});

test('ipOlt (AutoISP): consulta filtrada pelo ID, com cache', async () => {
    const log = [];
    const fetchFn = async url => {
        const u = new URL(url);
        log.push(u.pathname + u.search);
        return resposta({ olts: [{ id: 193, hostname: 'OLT-TESTE-01', ip: '10.9.8.7', model: 'X' }], total_count: 1 }, { url });
    };
    const c = core.criarClienteAutoIsp({ fetchFn });
    assert.equal((await c.ipOlt('193')).ip, '10.9.8.7');
    await c.ipOlt('193');
    assert.equal(log.length, 1);
    assert.match(log[0], /^\/olts\/olts_list\?olt_id=193&/);
    await assert.rejects(c.ipOlt('abc'), e => e.codigo === 'ENTRADA');
});

test('consultarOnu: traz o ID da OLT do AutoISP', async () => {
    const o = await core.criarClienteAutoIsp({ fetchFn: autoispFalso({ busca: q => (q.erp_id === 'TESTE12345' ? [{ ...CLIENTE_AUTOISP, olt_id: 193 }] : []) }).fetchFn })
        .consultarOnu('TESTE12345');
    assert.equal(o.oltId, '193');
});

test('ipDoUpe (Amigo): lê os parâmetros uma vez, busca pelo nome e guarda em cache', async () => {
    const srv = servidorFalso([
        { re: /^\/pt\/network-documentation\/actives$/, fn: () => resposta(PAGINA_ATIVOS) },
        { re: /^\/datatables\/default$/, metodo: 'POST', fn: (m, corpo) => resposta({ data: [LINHA_ATIVO(corpo['search[value]'], '10.0.0.5')] }) }
    ]);
    const c = cliente(srv);
    assert.equal((await c.ipDoUpe('OLT-TESTE-01')).ip, '10.0.0.5');
    assert.equal((await c.ipDoUpe('OLT-TESTE-01')).ip, '10.0.0.5');
    assert.equal((await c.ipDoUpe('OLT-TESTE-02')).ip, '10.0.0.5');
    assert.deepEqual(srv.log.map(l => l.caminho), ['/pt/network-documentation/actives', '/datatables/default', '/datatables/default']);
    const post = srv.log[1].corpo;
    assert.equal(post.route, 'company_network_documentation_actives');
    assert.equal(post['search[value]'], 'OLT-TESTE-01');
    await assert.rejects(c.ipDoUpe('<script>'), e => e.codigo === 'ENTRADA');
});
