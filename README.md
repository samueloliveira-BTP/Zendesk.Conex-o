# Assistente de Diagnóstico Zendesk

Extensão do Chrome (Manifest V3) que mostra, no ticket do Zendesk, o diagnóstico da conexão do cliente
com dados da Plataforma Amigo e da ONU (AutoISP): status, sinal, IP da OLT, conferência da Abordagem,
print da ONU na observação interna e atalhos para Amigo, AutoISP e Zabbix.

## Instalar (primeira vez)

1. Baixe o `.zip` da [última release](https://github.com/samueloliveira-BTP/Zendesk.Conex-o/releases/latest)
   e descompacte numa pasta fixa (ex.: `Documentos\Assistente-Zendesk`).
2. No Chrome, abra `chrome://extensions` e ative o **Modo do desenvolvedor** (canto superior direito).
3. Clique em **Carregar sem compactação** e selecione a pasta descompactada.
4. Dê F5 no Zendesk. Mantenha-se logado na Amigo, no AutoISP e no Zabbix.

## Atualizar

Quando houver versão nova, o ícone da extensão mostra **NEW** e o painel do ticket mostra
"Nova versão da extensão … **Baixar**".

1. Baixe o `.zip` novo e descompacte **por cima da mesma pasta** (substituindo os arquivos).
2. Em `chrome://extensions`, clique em **recarregar** (↻) na extensão.
3. Dê F5 no Zendesk.

## Desenvolvimento

- Sem etapa de build: HTML, CSS e JavaScript puros.
- Testes: `node --test tests/amigo-core.test.js tests/texto-diagnostico.test.js` (só dados fictícios).
- Release: atualize `version` no `manifest.json`, faça commit e envie uma tag `vX.Y.Z` igual à versão.
  O GitHub Actions (`.github/workflows/release.yml`) confere a versão, roda os testes, monta o `.zip`
  e publica a release.

Bibliotecas de terceiros: [html2canvas](https://html2canvas.hertzen.com) 1.4.1 (MIT, ver `lib/html2canvas.LICENSE.txt`).
