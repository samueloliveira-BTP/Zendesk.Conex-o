/**
 * Servidor da página de demonstração (screenshots da Chrome Web Store).
 *
 * Roda o content.js DE VERDADE numa página que imita o layout de um ticket, com as respostas do service
 * worker trocadas por DADOS FICTÍCIOS (dados-ficticios.js). Nada é consultado na Amigo, no AutoISP ou no
 * Zendesk. Só escuta em 127.0.0.1.
 *
 *   node loja/demo/servidor.js          → http://127.0.0.1:8765/agent/tickets/123456
 *   ...?cenario=abordagem               → com a faixa "Abordagem incompleta"
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORTA = Number(process.env.PORTA_DEMO) || 8765;
const RAIZ = path.resolve(__dirname, '..', '..');

/** content.js com duas trocas: roda neste host (127.0.0.1) e usa o "chrome" falso da demonstração. */
function contentDemo() {
    const original = fs.readFileSync(path.join(RAIZ, 'content.js'), 'utf8');
    const alvo = "if (location.hostname.endsWith('.zendesk.com')) {";
    if (!original.includes(alvo)) throw new Error('Inicialização do content.js mudou: ajuste o servidor da demonstração.');
    return `(function (chrome) {\n${original.replace(alvo, 'if (true) {')}\n})(window.chromeDemo);\n`;
}

const arquivos = {
    '/demo.css': ['demo.css', 'text/css'],
    '/dados-ficticios.js': ['dados-ficticios.js', 'text/javascript']
};

http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORTA}`);
    try {
        if (/^\/agent\/tickets\/\d+$/.test(url.pathname)) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
        }
        if (url.pathname === '/content-demo.js') {
            res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
            return res.end(contentDemo());
        }
        const a = arquivos[url.pathname];
        if (a) {
            res.writeHead(200, { 'Content-Type': `${a[1]}; charset=utf-8` });
            return res.end(fs.readFileSync(path.join(__dirname, a[0])));
        }
        res.writeHead(302, { Location: '/agent/tickets/123456' });
        res.end();
    } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Erro na demonstração.'); // sem detalhes internos
        console.error(e.message);
    }
}).listen(PORTA, '127.0.0.1', () => console.log(`Demonstração: http://127.0.0.1:${PORTA}/agent/tickets/123456`));
