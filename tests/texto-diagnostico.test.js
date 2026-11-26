/**
 * Testes do texto de teste copiado para o ticket (montarTextoDiagnostico, em content.js), no padrão da equipe:
 *   --- TESTES CSA / ROTEADOR / ONU ---  e, sem acesso,  --- LOGÍSTICA / O.S. ---
 * O content.js real é carregado num contexto isolado (vm), sem DOM: só as funções puras são usadas.
 * Rodar:  node --test tests/
 * Todos os dados são FICTÍCIOS.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Contexto mínimo: o content.js só inicializa em hosts conhecidos, então nada de DOM é tocado.
const contexto = vm.createContext({ location: { hostname: 'teste.local', pathname: '/' }, console, Date, Intl, URLSearchParams });
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8'), contexto);
const { montarTextoDiagnostico, tipoDoTeste, fabricantePeloSerial } = contexto;

const SEM_ACESSO = {
    estado: 'offline', sessaoFim: '11-10-2026 09:00:00', contrato: 'Normal', ip: '100.64.1.1', modelo: '',
    conexao: { nome: 'Fulano de Teste', etiqueta: 'TESTE12345', plano: 'Plano Fictício 500 Mega' }
};
const COM_ACESSO = { ...SEM_ACESSO, estado: 'online', sessaoFim: '', sessaoInicio: '11-10-2026 08:00:00' };
const ONU = (problema, texto, estado = 'offline') => ({
    statusOnu: { estado, problema, texto, quando: '2026-10-11T12:00:00.000Z' },
    sinal: { texto: '-18.36 dBm', quando: '2026-10-11T03:00:00.000Z', classificacao: { rotulo: 'Bom' } },
    ultimaQueda: { texto: 'LOS', quando: '2026-10-11T12:00:00.000Z' },
    eventos: [{ texto: 'LOS', quando: '2026-10-11T12:00:00.000Z' }, { texto: 'UP', quando: '2026-10-10T12:00:00.000Z' }],
    olt: 'BR-XX-TESTE-OLT-01', ponlink: '1/1/10', onuId: '61', servicePort: '911', vlan: '1010',
    descricaoOlt: 'CE-TESTE-CAIXA-01', serial: '485754430FBB1630', sessao: { ip: '100.64.9.9', fim: '2026-10-11T12:00:00.000Z' }
});

test('LOS sem acesso: segue o modelo da equipe e termina com o bloco da logística', () => {
    const t = montarTextoDiagnostico('los', SEM_ACESSO, ONU('los', 'LOS (sem sinal óptico)'),
        { splitter: 'CTO-TESTE – Porta 5', caixa: { on: 6, off: 0, ind: 0, total: 6 } });
    const linhas = t.split('\n');
    assert.equal(linhas[0], '--- TESTES CSA / ROTEADOR / ONU ---');
    assert.equal(linhas[1], 'Verificado ONU DOWN (LINK LOSS)');
    for (const esperado of [
        'Local: CE-TESTE-CAIXA-01',
        'Link: BR-XX-TESTE-OLT-01 1/1/10 ID 61',
        'Service Port: 911',
        'VLAN: 1010',
        'Modelo da ONU: Huawei (HWTC)',      // pelo prefixo do serial, já que a Amigo não informou o modelo
        'Plano desconectado desde: 11-10-2026 09:00:00',
        'Demais clientes da caixa estão UP (6 de 6 online)',
        'Energia confirmada',
        'Equipamentos reiniciados sem sucesso',
        'Cabos verificados',
        '--- LOGÍSTICA / O.S. ---',
        'Cliente sem acesso, ONU DOWN com link loss.',
        'Encaminhar técnico.'
    ]) assert.ok(linhas.includes(esperado), `faltou "${esperado}"\n${t}`);
    assert.match(t, /^Último sinal ONU: -18\.36 dBm \(Bom\) em /m);
    assert.match(t, /^IP: 100\.64\.9\.9$/m); // IP do AutoISP
    assert.equal(linhas[linhas.indexOf('--- LOGÍSTICA / O.S. ---') - 1], '', 'linha em branco antes da logística');
    assert.equal(linhas[linhas.length - 1], 'Encaminhar técnico.');
    assert.ok(!/undefined|null|NaN/.test(t), t);
});

test('campos sem dado aparecem como "–", como no modelo', () => {
    const t = montarTextoDiagnostico('down', { ...SEM_ACESSO, sessaoFim: '' }, { statusOnu: { estado: 'offline', problema: 'down', texto: 'Down' } });
    for (const l of ['Local: –', 'Link: –', 'Service Port: –', 'VLAN: –', 'Modelo da ONU: –', 'Último sinal ONU: –']) {
        assert.ok(t.split('\n').includes(l), `faltou "${l}"\n${t}`);
    }
    assert.match(t, /Demais clientes da caixa: não verificado/);
    assert.ok(!/undefined|null|NaN/.test(t), t);
});

test('cliente com acesso: só o bloco de testes, sem O.S.', () => {
    const t = montarTextoDiagnostico(tipoDoTeste(COM_ACESSO, ONU(null, 'Online (UP)', 'online')), COM_ACESSO, ONU(null, 'Online (UP)', 'online'));
    assert.match(t, /^--- TESTES CSA \/ ROTEADOR \/ ONU ---\nVerificado ONU UP, cliente com acesso/);
    assert.ok(!/LOGÍSTICA/.test(t));
    assert.match(t, /Status da conexão \(Amigo\): Online – sessão desde 11-10-2026 08:00:00/);
});

test('tipoDoTeste: problema da ONU; sem acesso com ONU UP = PPPoE; sem dados da ONU = sem acesso', () => {
    assert.equal(tipoDoTeste(SEM_ACESSO, ONU('dgi', 'Sem energia (DGI)')), 'dgi');
    assert.equal(tipoDoTeste(COM_ACESSO, ONU('los', 'LOS')), 'los'); // problema na ONU vale mesmo com a Amigo online
    assert.equal(tipoDoTeste(SEM_ACESSO, ONU(null, 'Online (UP)', 'online')), 'pppoe');
    assert.equal(tipoDoTeste(SEM_ACESSO, null), 'semacesso');
    assert.equal(tipoDoTeste(COM_ACESSO, ONU(null, 'Online (UP)', 'online')), null);
    assert.equal(tipoDoTeste(null, null), null);
    assert.match(montarTextoDiagnostico('pppoe', SEM_ACESSO, ONU(null, 'Online (UP)', 'online')), /ONU UP sem autenticação PPPoE[\s\S]*Encaminhar técnico\./);
});

test('DGI, Down, não disponível e massivas', () => {
    const dgi = montarTextoDiagnostico('dgi', SEM_ACESSO, ONU('dgi', 'Sem energia (DGI)'));
    assert.match(dgi, /Verificado ONU DOWN \(DYING GASP – SEM ENERGIA\)/);
    assert.match(dgi, /Encaminhar técnico para verificar\/trocar a fonte da ONU\./);
    assert.match(montarTextoDiagnostico('indisponivel', SEM_ACESSO, ONU('indisponivel', 'Não disponível')), /Verificado ONU NÃO DISPONÍVEL na OLT/);
    for (const tipo of ['massiva-los', 'massiva']) {
        const t = montarTextoDiagnostico(tipo, SEM_ACESSO, ONU(tipo, 'Massiva'));
        assert.match(t, /--- LOGÍSTICA \/ O\.S\. ---\n.*massiva/i);
        assert.match(t, /NÃO abrir O\.S\. individual/);
        assert.ok(!/Energia confirmada|Encaminhar técnico/.test(t), 'massiva não tem checklist nem técnico');
    }
});

test('"Demais clientes da caixa" a partir da verificação do splitter', () => {
    const caixa = cx => montarTextoDiagnostico('los', SEM_ACESSO, ONU('los', 'LOS'), { caixa: cx });
    assert.match(caixa({ on: 3, off: 1, ind: 0, total: 4 }), /Demais clientes da caixa: 3 online, 1 offline/);
    assert.match(caixa({ on: 1, off: 4, ind: 0, total: 5 }), /Demais clientes da caixa: 4 de 5 OFFLINE – possível massiva/);
    assert.match(caixa({ on: 0, off: 0, ind: 0, total: 0 }), /Cliente único na caixa/);
});

test('fabricantePeloSerial', () => {
    assert.equal(fabricantePeloSerial('485754430FBB1630'), 'Huawei (HWTC)');
    assert.equal(fabricantePeloSerial('DGST21408C65'), 'Digistar (DGST)');
    assert.equal(fabricantePeloSerial('5A54454712345678'), 'ZTE (ZTEG)');
    assert.equal(fabricantePeloSerial('ABCD00000001'), 'ABCD'); // código desconhecido: mostra o código
    assert.equal(fabricantePeloSerial(''), '');
    assert.equal(fabricantePeloSerial(null), '');
});
