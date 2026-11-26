# Política de Privacidade — Assistente de Diagnóstico Zendesk

> **RASCUNHO — validar com o responsável interno de LGPD/Jurídico da Brasiltecpar antes de publicar.**

Última atualização: 26/11/2026

## Quem usa

O Assistente de Diagnóstico Zendesk é uma ferramenta **interna** da Brasiltecpar, distribuída pela Chrome
Web Store com visibilidade **particular**: só pode ser instalada por contas Google do domínio
`@brasiltecpar.com.br`. Ela é usada pelos atendentes de suporte no atendimento de tickets.

## Que dados a extensão acessa

Para montar o painel de diagnóstico dentro do ticket, a extensão lê, **com a sessão que o próprio atendente
já tem aberta** nos sistemas da empresa:

- **Zendesk:** o número do ticket e o campo de identificação da conexão do cliente.
- **Plataforma Amigo:** dados técnicos da conexão (plano, status, IP atual, equipamento, splitter,
  abordagem) e o nome/contrato do cliente.
- **AutoISP:** dados técnicos da ONU (status, sinal, quedas, OLT, slot/porta).

## O que a extensão faz com esses dados

- Mostra as informações ao atendente, no painel do ticket.
- **Somente quando o atendente clica:** salva um print da página da ONU como **nota interna** do próprio
  ticket, e abre a tela de edição da Amigo já preenchida (quem salva é o atendente).
- Com a sessão do cliente ativa, testa se o roteador do cliente responde por web no **IP atual daquela
  conexão** (lista fixa de portas), para oferecer o link "Acessar roteador".
- Consulta o fabricante do equipamento em `api.macvendors.com` enviando **apenas o prefixo do MAC**
  (os 6 primeiros dígitos, que identificam o fabricante, não o equipamento).

## O que a extensão NÃO faz

- Não envia dados para servidores do desenvolvedor nem de terceiros (exceto o prefixo do MAC acima).
- Não tem analytics, rastreamento ou publicidade.
- Não vende nem compartilha dados.
- Não guarda senhas nem tokens: usa a sessão já aberta no navegador.

## Armazenamento

Os dados consultados ficam só na memória do navegador enquanto o painel está aberto (cache de poucos
minutos). Não há banco de dados da extensão. Os prints salvos ficam no Zendesk, sob as regras de retenção
do próprio Zendesk.

## Contato

Dúvidas sobre esta política: equipe de Suporte/TI da Brasiltecpar, pelos canais internos.
