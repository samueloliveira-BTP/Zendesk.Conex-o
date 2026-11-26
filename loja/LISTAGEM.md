# Chrome Web Store — o que preencher no painel do desenvolvedor

Textos prontos para copiar. O `.zip` a enviar é o da release do GitHub
(`assistente-diagnostico-zendesk-vX.Y.Z.zip`), que já tem o `manifest.json` na raiz.

---

## 1. Pacote (aba "Pacote")

Enviar o `.zip`. Cada envio novo precisa de versão maior no `manifest.json` (a release já garante isso).

## 2. Listagem na loja (aba "Listagem da loja")

**Descrição** (copiar):

```
Ferramenta interna da Brasiltecpar para os atendentes de suporte.

Dentro do ticket do Zendesk, mostra um painel de diagnóstico da conexão do cliente com dados da
Plataforma Amigo e do AutoISP:
• status da conexão e da ONU, sinal, últimas quedas;
• IP da OLT com atalho para o Zabbix;
• conferência da Abordagem (Slot/Porta OLT, ID ONU) e atalho para corrigir na Amigo;
• print da ONU salvo como nota interna do ticket, com um clique;
• link "Acessar roteador" quando o roteador do cliente responde por web.

Usa a sessão que o atendente já tem aberta nos sistemas. Não envia dados para fora da empresa.
```

- **Categoria:** Ferramentas do desenvolvedor → ou "Produtividade" / "Ferramentas" (a que existir).
- **Idioma:** Português (Brasil).
- **Ícone da loja:** `icons/icon128.png`.
- **Capturas de tela:** `loja/screenshots/1-painel.png`, `2-onu.png`, `3-abordagem.png` (1280×800, dados
  fictícios). Para refazer: `node loja/demo/servidor.js` e abrir http://127.0.0.1:8765/agent/tickets/123456
  (`?rolar=1250` = seção ONU; `?cenario=abordagem` = faixa vermelha). Nunca usar ticket real (LGPD).

## 3. Privacidade (aba "Práticas de privacidade")

**Finalidade única** (copiar):

```
Mostrar aos atendentes de suporte da Brasiltecpar, dentro do ticket do Zendesk, o diagnóstico da conexão
do cliente (dados da Plataforma Amigo e do AutoISP), com atalhos para as ferramentas internas.
```

**Justificativa das permissões** (copiar cada uma no campo correspondente):

| Permissão | Justificativa |
|---|---|
| `storage` | Guardar no próprio navegador um cache do fabricante por prefixo de MAC (evita consultar a mesma marca de novo). Nenhum dado de cliente é guardado. |
| `plataforma.sejaamigo.com.br` | Ler os dados da conexão do cliente na Plataforma Amigo (sistema interno da empresa) com a sessão do atendente, e preencher a tela de edição da Abordagem para o atendente salvar. |
| `autoisp.brasiltecpar.com.br` | Ler o status da ONU e o IP da OLT no AutoISP (sistema interno da empresa) e capturar o print da página da ONU quando o atendente pede. |
| `api.macvendors.com` | Identificar o fabricante do equipamento pelo prefixo do MAC (só os 6 primeiros dígitos são enviados). |
| Scripts de conteúdo (Zendesk, Amigo, AutoISP) | Mostrar o painel dentro do ticket do Zendesk; preencher a edição da Amigo; capturar o print no AutoISP. |
| Acesso à rede local (pedido uma vez) | Testar se o roteador do cliente atendido responde por web no IP atual da conexão dele, para o link "Acessar roteador". Só testa esse IP, só com a sessão ativa e só uma lista fixa de portas web. |

**Código remoto:** **Não**, não uso código remoto (todo o JavaScript vai no pacote; `html2canvas` está em `lib/`).

**Uso de dados — marcar:**
- [x] Informações de identificação pessoal (nome/contrato do cliente exibidos ao atendente)
- [x] Local (endereço IP da conexão do cliente)
- [x] Conteúdo do site (dados lidos das páginas da Amigo/AutoISP/Zendesk)
- [ ] todas as outras categorias: **não**

**Certificações — marcar as três:**
- [x] Não vendo nem transfiro dados a terceiros fora dos casos de uso aprovados
- [x] Não uso nem transfiro dados para finalidades não relacionadas à finalidade única
- [x] Não uso nem transfiro dados para avaliar crédito ou conceder empréstimos

**URL da política de privacidade:**
`https://github.com/samueloliveira-BTP/Zendesk.Conex-o/blob/main/PRIVACIDADE.md`
(só depois do texto validado pelo responsável de LGPD/Jurídico e do push)

## 4. Distribuição (aba "Distribuição")

- **Visibilidade:** **Particular** → "Somente usuários do domínio brasiltecpar.com.br".
- **Regiões:** Brasil (ou todas — com visibilidade particular não faz diferença).
- Opcional (admin do Google Workspace): no Admin Console → Chrome → Apps e extensões, **forçar a instalação**
  para a unidade organizacional do suporte. Aí nenhum atendente precisa instalar à mão.

## 5. Depois de aprovada

- Cada atendente **remove a versão antiga** (a carregada "sem compactação" / pelo .zip) e instala pela loja.
  As duas juntas mostrariam dois painéis.
- Daí em diante o Chrome atualiza sozinho. Versão nova = mudar a versão no `manifest.json` → tag → release →
  enviar o `.zip` no painel da loja.
