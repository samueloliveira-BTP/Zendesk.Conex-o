/**
 * "chrome.runtime" falso para a demonstração: responde às mensagens do content.js com DADOS FICTÍCIOS.
 * Nenhum dado real (LGPD): nomes de demonstração, IPs das faixas reservadas para documentação
 * (198.51.100.0/24 e 203.0.113.0/24, RFC 5737) e MAC da faixa de exemplo da IANA (00:00:5E:00:53:xx).
 */
'use strict';

(function () {
    const cenario = new URLSearchParams(location.search).get('cenario') || 'normal';
    const agora = Date.now();
    const iso = msAtras => new Date(agora - msAtras).toISOString();
    const H = 3600e3;
    const IP_CLIENTE = '198.51.100.23';

    const conexao = {
        id: '000000', etiqueta: 'DEMO-0001', nome: 'Cliente Demonstração da Silva', tipo: 'PPPoE',
        plano: 'Fibra 500 Mega (demonstração)', usuarioPppoe: 'cliente.demo', concentrador: 'BNG-DEMO-01',
        pontoAcesso: 'OLT-DEMO-CENTRO', ctoId: '1', slot: '4', porta: '7', ativo: true
    };

    const respostas = {
        consultarCliente: () => ({
            data: {
                estado: 'online', motivo: 'Sessão ativa no RADIUS (dados de demonstração).',
                sessaoInicio: new Date(agora - 5 * H).toLocaleString('pt-BR').slice(0, 17),
                ip: IP_CLIENTE, contrato: 'Ativo', conexao, statusOlt: 'Online',
                mac: '00:00:5E:00:53:01', usuarioEquip: 'admin', senhaEquip: 'senha-demo',
                tipoEquip: 'Roteador', modelo: 'Wi-Fi 6 DEMO', firmware: 'v1.0.0-demo', limite: '500 Mbps / 250 Mbps',
                usuarioRadius: 'cliente.demo', massivas: 0, correspondencias: 1, filtro: 'serviceTag', consultadoEm: agora
            }
        }),
        consultarOnu: () => ({
            data: {
                statusOnu: { estado: 'online', texto: 'Online', fonte: 'status' },
                sinal: { texto: '-19.85 dBm', atual: true, classificacao: { tipo: 'ok', rotulo: 'Bom' } },
                statusAtual: {
                    estado: 'online', rxOlt: '-21.30 dBm', distancia: '1.2 km', modelo: 'ONU-DEMO-1G',
                    firmware: 'V1.0.0', ultimoOff: iso(5 * H), causaOff: 'dying-gasp'
                },
                ultimaQueda: { texto: 'Dying gasp (falta de energia)', quando: iso(5 * H) },
                olt: 'OLT-DEMO-CENTRO', oltId: '1', ponlink: '0/4/7', onuId: '12', servicePort: '3456', vlan: '100',
                sessao: { ip: IP_CLIENTE, inicio: iso(5 * H) },
                link: 'https://autoisp.brasiltecpar.com.br/contracted_services/0', gponId: 'demo', eventos: []
            }
        }),
        abordagem: () => {
            const incompleta = cenario === 'abordagem';
            const item = (campo, rotulo, amigo, autoisp) => ({
                campo, rotulo, amigo: incompleta && campo !== 'tecnologia' ? '' : amigo, autoisp,
                estado: incompleta && campo !== 'tecnologia' ? 'faltando' : 'ok'
            });
            const itens = [item('tecnologia', 'Tecnologia', 'GPON', 'GPON'), item('slot', 'Slot OLT', '4', '4'),
                item('porta', 'Porta OLT', '7', '7'), item('onuId', 'ID ONU', '12', '12')];
            return { data: { itens, temOnu: true, idConexao: conexao.id, totalPreencher: incompleta ? 3 : 0 } };
        },
        ipOlt: () => ({ data: { ip: '203.0.113.10', fonte: 'AutoISP' } }),
        nomeSplitter: () => ({ nome: 'CTO-DEMO-07' }),
        // ?cenario=mikrotik → fabricante MikroTik (sem teste de portas)
        fabricanteMac: () => ({ fabricante: cenario === 'mikrotik' ? 'Routerboard.com' : 'Fabricante Exemplo' }),
        testarPortas: () => ({
            data: {
                ip: IP_CLIENTE, permissao: 'granted', duracaoMs: 2100,
                portas: [
                    { porta: 80, estado: 'aberta', url: `http://${IP_CLIENTE}/`, ms: 42 },
                    { porta: 8080, estado: 'aberta', url: `http://${IP_CLIENTE}:8080/`, ms: 55 },
                    { porta: 443, estado: 'inconclusiva', ms: 60 },
                    { porta: 22, estado: 'nao-testavel', ms: 0 },
                    { porta: 23, estado: 'nao-testavel', ms: 0 }
                ]
            }
        })
    };

    // Ações que mexem em sistemas reais (salvar print, abrir Amigo) ficam desligadas na demonstração.
    const DEMORA_MS = { consultarCliente: 500, consultarOnu: 350, abordagem: 250, testarPortas: 600 };

    window.chromeDemo = {
        runtime: {
            id: 'demonstracao', lastError: null,
            sendMessage(msg, responder) {
                const f = respostas[msg && msg.action];
                setTimeout(() => responder(f
                    ? { success: true, ...f(msg) }
                    : { success: false, error: 'Indisponível na demonstração.' }), DEMORA_MS[msg && msg.action] || 150);
            }
        }
    };
})();
