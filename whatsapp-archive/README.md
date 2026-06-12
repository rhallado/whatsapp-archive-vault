# Telenova WhatsApp Archive Exporter

Ferramenta web para importar o histórico do **WhatsApp Business App** via QR Code e gerar um arquivo `.zip` **offline** contendo HTML, CSS, JavaScript, dados e mídias. O cliente extrai o ZIP, abre o `index.html` no navegador e consulta o histórico **sem internet, sem servidor e sem banco de dados**.

> ⚠ **Somente leitura.** Esta ferramenta nunca envia mensagens, nunca dispara mensagens em massa e não automatiza atendimento. Único objetivo: importar histórico e gerar um arquivo offline.

---

## Arquitetura

Tudo em um único container Docker:

- **Backend Node.js/TypeScript** (Express) servindo:
  - UI web admin (HTML/CSS/JS vanilla, sem build extra) em `/`
  - API REST em `/api/*`
  - Worker WhatsApp usando `whatsapp-web.js` + Puppeteer/Chromium
- Sem Supabase, sem Cloudflare Workers, sem dependência do Lovable.
- Autenticação obrigatória por `ADMIN_TOKEN` (cookie httpOnly).
- Volumes persistentes para sessões temporárias e ZIPs gerados. A listagem e o download são reconstruídos a partir dos arquivos físicos após reinícios.

```
┌─────────────────────────────────────────────────────┐
│  Browser (admin) ── /login.html, /, /api/*          │
│         │                                           │
│         ▼                                           │
│  Express server (porta 3000 interna)                │
│   ├─ /api/auth/*    login via ADMIN_TOKEN           │
│   ├─ /api/export/*  start/qr/status/cancel/...      │
│   └─ static admin UI                                │
│         │                                           │
│         ▼                                           │
│  whatsapp-web.js + Chromium (Puppeteer)             │
│         │                                           │
│         ▼                                           │
│  /data/tmp     → mensagens + mídias durante import  │
│  /data/exports → ZIPs finais                        │
│  /data/sessions→ sessão WhatsApp Web (LocalAuth)    │
└─────────────────────────────────────────────────────┘
```

---

## Deploy rápido (Portainer / VPS)

### 1. Clone e configure o ambiente

```bash
git clone <este-repo>
cd whatsapp-archive
cp .env.example .env
# edite .env: ADMIN_TOKEN (use `openssl rand -hex 32`), PUBLIC_URL, HOST_PORT
```

### 2. Suba com docker-compose

Use o `docker-compose.yml` que está na **raiz do repositório** (ele aponta o build para `./whatsapp-archive`):

```bash
docker compose up -d --build
```

Ou, se preferir usar o compose dentro desta pasta:

```bash
cd whatsapp-archive
docker compose up -d --build
```

Acesse: `http://<seu-host>:3001` → faça login com o `ADMIN_TOKEN`.

### 3. Deploy no Portainer (Stack from Git)

1. Portainer → **Stacks** → **Add stack** → **Repository**.
2. Cole a URL do repositório GitHub.
3. Em **Compose path**, deixe `docker-compose.yml` (na raiz do repo).
4. Na seção **Environment variables**, adicione:
   - `ADMIN_TOKEN` = (gere um valor longo e aleatório)
   - `PUBLIC_URL` = `http://190.89.248.194:3001` (ou seu domínio)
   - `HOST_PORT` = `3001`
5. **Deploy the stack**.
6. (Opcional) Configure um reverse proxy (Nginx/Caddy/Traefik) na frente
   apontando para o container e use HTTPS com domínio próprio.

> **HTTPS recomendado em produção.** Sem TLS, o `ADMIN_TOKEN` trafega em texto claro.

---

## Variáveis de ambiente

| Variável | Obrigatório | Default | Descrição |
|---|---:|---|---|
| `ADMIN_TOKEN` | sim | — | Token de login (mínimo 12 caracteres). |
| `PUBLIC_URL` | recomendado | `http://localhost:3001` | URL pública da aplicação. |
| `HOST_PORT` | não | `3001` | Porta exposta no host. |
| `MAX_MESSAGES_PER_CHAT` | não | `20000` | Máximo de mensagens solicitadas por conversa. |
| `MAX_CONCURRENT_EXPORTS` | não | `1` | Exportações simultâneas. |
| `SAFE_MODE` | não | `true` | Ativa pausas técnicas entre operações. |
| `CHAT_DELAY_MS` | não | `2500` | Pausa entre conversas. |
| `MEDIA_DELAY_MS` | não | `800` | Pausa entre downloads de mídia. |
| `MAX_CHATS_PER_RUN` | não | `0` | Máximo de conversas; `0` significa sem limite. |
| `MAX_MEDIA_PER_RUN` | não | `0` | Máximo de mídias; `0` significa sem limite. |
| `SESSION_DIR` | não | `/data/sessions` | Sessões locais do WhatsApp Web. |
| `EXPORT_DIR` | não | `/data/exports` | ZIPs persistentes gerados. |
| `TMP_DIR` | não | `/data/tmp` | Arquivos temporários e agendas durante a execução. |

Volumes nomeados (`wa_sessions`, `wa_exports`, `wa_tmp`) são criados automaticamente pelo compose.

`SAFE_MODE` adiciona pausas entre operações para reduzir carga e tornar a exportação menos agressiva. Isso não garante aceitação pela plataforma.

### Onde ficam os ZIPs

Dentro do Docker, os arquivos ficam em `/data/exports`, que pertence ao container/volume nomeado e não aparece automaticamente em `/data/exports` no host.

```bash
docker exec -it telenova-wa-archive sh -lc 'ls -lh /data/exports'
docker cp telenova-wa-archive:/data/exports/NOME_DO_ARQUIVO.zip ./NOME_DO_ARQUIVO.zip
```

A tela **Exportações recentes** varre essa pasta; portanto, ZIPs preservados continuam listados e disponíveis para download após refresh, restart ou redeploy com o mesmo volume.

---

## Endpoints da API

Todos exigem o cookie `tn_admin` (definido pelo `POST /api/auth/login`) ou header `Authorization: Bearer <ADMIN_TOKEN>`.

| Método | Caminho                          | Descrição                                       |
|--------|----------------------------------|-------------------------------------------------|
| POST   | `/api/auth/login`                | Login (`{ token }`)                             |
| POST   | `/api/auth/logout`               | Logout                                          |
| GET    | `/api/auth/me`                   | Status de autenticação                          |
| GET    | `/api/export`                    | Lista jobs em memória e ZIPs físicos persistidos |
| POST   | `/api/export/start`              | Cria exportação; aceita multipart com `options` e agenda `contacts` |
| GET    | `/api/export/:id/qr`             | QR Code atual (data URL)                        |
| GET    | `/api/export/:id/status`         | Status + progresso + logs                       |
| POST   | `/api/export/:id/cancel`         | Cancela importação em andamento                 |
| GET    | `/api/export/:id/download`       | Baixa o ZIP final                               |
| POST   | `/api/export/:id/disconnect`     | Para o job, desconecta e remove somente a sessão |
| DELETE | `/api/export/:id/cleanup`        | Apaga sessão, ZIP e arquivos temporários        |

---

## Estrutura do ZIP gerado

```
historico-whatsapp-<empresa>-<id>.zip
└── historico-whatsapp-<empresa>/
    ├── index.html         ← visualizador offline
    ├── app.js
    ├── style.css
    ├── manifest.json
    ├── README.html
    ├── data/
    │   ├── manifest.js    (window.MANIFEST)
    │   ├── chats.js       (window.CHATS)
    │   ├── search_index.js(window.SEARCH_INDEX)
    │   └── messages_chat_XXX.js  (window.MESSAGES_chat_XXX)
    └── media/
        └── chat_XXX/...   (imagens, áudios, vídeos, documentos)
```

O visualizador **não usa `fetch()`** — todos os dados ficam em `.js` que populam variáveis em `window.*`. Funciona via `file://` em qualquer navegador moderno (Chrome, Firefox, Edge, Safari), sem servidor local.

---

## Segurança e LGPD

- O `ADMIN_TOKEN` é obrigatório e validado em todas as rotas de API.
- A UI exibe aviso LGPD antes de iniciar cada exportação.
- Após cada exportação a operadora pode:
  - **Baixar o ZIP** (entregar ao cliente)
  - **Parar e desconectar a sessão** sem apagar ZIPs
  - **Apagar sessão e ZIP desta exportação** somente após confirmação explícita
- O ZIP final fica sob responsabilidade do cliente final — a Telenova
  não armazena cópia após a entrega.
- Recomendado: rodar atrás de HTTPS (Caddy/Nginx/Traefik) com domínio próprio.

---

## Limitações conhecidas (whatsapp-web.js)

- Apenas mensagens **sincronizadas com o WhatsApp Web** são acessíveis (o histórico que aparece em web.whatsapp.com).
- Nomes podem depender dos dados disponibilizados pelo WhatsApp Web. Opcionalmente, envie uma agenda `.csv` (`name`/`nome`/`fullName` + `phone`/`telefone`/`number`/`numero`) ou `.vcf` (`FN` + `TEL`) antes da exportação; ela é usada apenas temporariamente e não entra no ZIP.
- Mensagens **apagadas** antes da exportação não retornam conteúdo.
- Mensagens **temporárias** e mídias **expiradas** podem não aparecer.
- Use a ferramenta somente com autorização do titular e conforme as políticas aplicáveis.

## Correção de nomes em ZIP existente

A correção pós-exportação por upload de ZIP e agenda está planejada. Atualmente, a agenda CSV/VCF deve ser fornecida no formulário antes de iniciar a exportação.

---

## Desenvolvimento local (sem Docker)

```bash
cd whatsapp-archive
npm install
cp .env.example .env  # configure ADMIN_TOKEN
export $(cat .env | xargs)
mkdir -p data/sessions data/exports data/tmp
SESSION_DIR=./data/sessions EXPORT_DIR=./data/exports TMP_DIR=./data/tmp npm run dev
```

Precisa de Chromium/Chrome instalado e do path em `PUPPETEER_EXECUTABLE_PATH`
(ou deixe em branco para o Puppeteer baixar — exigirá ajustar `package.json`).
