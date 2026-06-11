import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Telenova WhatsApp Archive Exporter" },
      {
        name: "description",
        content:
          "Ferramenta da Telenova para exportar histórico do WhatsApp Business em arquivo ZIP offline antes da migração para WhatsApp API.",
      },
      { property: "og:title", content: "Telenova WhatsApp Archive Exporter" },
      {
        property: "og:description",
        content:
          "Importa histórico do WhatsApp via QR Code e gera ZIP autocontido (HTML/CSS/JS/mídia) para consulta offline.",
      },
    ],
  }),
  component: Landing,
});

function Landing() {
  return (
    <div className="min-h-screen bg-[#0b1220] text-[#e6edf6]">
      <header className="border-b border-[#1f2a3d] bg-gradient-to-b from-[#0e1a30] to-[#0b1220]">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <div>
            <strong className="text-lg">Telenova</strong>
            <span className="ml-2 text-sm text-[#8aa0bd]">WhatsApp Archive Exporter</span>
          </div>
          <span className="rounded-full border border-[#1f2a3d] bg-[#13213a] px-3 py-1 text-xs uppercase tracking-wider text-[#22d3ee]">
            v1.0.0
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-10">
        <section className="rounded-xl border border-[#1f2a3d] bg-[#111c2e] p-8 shadow-[0_6px_24px_rgba(0,0,0,.25)]">
          <h1 className="text-3xl font-semibold leading-tight">
            Backup offline do WhatsApp Business antes da migração para a API
          </h1>
          <p className="mt-3 max-w-3xl text-[#8aa0bd]">
            Conecte uma vez via QR Code, baixe todas as conversas, mídias e documentos
            e entregue ao cliente um arquivo <code className="rounded bg-[#0c1424] px-1.5 py-0.5">.zip</code>
            autocontido — abre no navegador, sem servidor, sem internet, sem banco.
          </p>

          <div className="mt-6 rounded-lg border border-[#5b4a1d] bg-[#221d10] p-4 text-sm text-[#ffe7b5]">
            ⚠ <strong>Somente leitura.</strong> Esta ferramenta nunca envia mensagens,
            nunca dispara mensagens em massa e não automatiza atendimento. Único
            objetivo: importar histórico e gerar um arquivo offline.
          </div>
        </section>

        <section className="mt-8 grid gap-4 md:grid-cols-2">
          <Card title="UI Admin">
            Tela de nova exportação, lista de exportações, QR Code, status em tempo real,
            progresso, logs, download do ZIP, desconectar sessão e apagar dados temporários.
          </Card>
          <Card title="Worker WhatsApp">
            <code className="rounded bg-[#0c1424] px-1.5 py-0.5">whatsapp-web.js</code> +
            Puppeteer + Chromium rodando no mesmo container. Importa chats, mensagens e mídias
            respeitando o período e filtros escolhidos.
          </Card>
          <Card title="Visualizador offline">
            HTML/CSS/JS estilo WhatsApp empacotado no ZIP. Busca global, filtros, bolhas,
            áudios, vídeos, documentos. Funciona via <code className="rounded bg-[#0c1424] px-1.5 py-0.5">file://</code>{" "}
            sem <code className="rounded bg-[#0c1424] px-1.5 py-0.5">fetch()</code>.
          </Card>
          <Card title="100% Docker">
            Um único <code className="rounded bg-[#0c1424] px-1.5 py-0.5">docker-compose.yml</code>{" "}
            pronto para Portainer. Volumes persistentes para sessões e exports. Autenticação
            obrigatória via <code className="rounded bg-[#0c1424] px-1.5 py-0.5">ADMIN_TOKEN</code>.
          </Card>
        </section>

        <section className="mt-10 rounded-xl border border-[#1f2a3d] bg-[#111c2e] p-8">
          <h2 className="text-xl font-semibold text-[#22d3ee]">Como rodar</h2>
          <p className="mt-2 text-sm text-[#8aa0bd]">
            O código vive em <code className="rounded bg-[#0c1424] px-1.5 py-0.5">whatsapp-archive/</code>{" "}
            neste repositório.
          </p>
          <pre className="mt-4 overflow-x-auto rounded-lg border border-[#1f2a3d] bg-[#06101f] p-4 text-sm leading-relaxed text-[#cfe1ff]">
{`cd whatsapp-archive
cp .env.example .env
# edite .env: ADMIN_TOKEN (openssl rand -hex 32), PUBLIC_URL, HOST_PORT
docker compose up -d --build

# abre em http://<seu-host>:3001 — login com o ADMIN_TOKEN`}
          </pre>

          <h3 className="mt-6 text-sm font-semibold uppercase tracking-wider text-[#8aa0bd]">
            Deploy no Portainer
          </h3>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
            <li>Portainer → <strong>Stacks</strong> → <strong>Add stack</strong>.</li>
            <li>
              Cole o conteúdo de{" "}
              <code className="rounded bg-[#0c1424] px-1.5 py-0.5">docker-compose.yml</code>.
            </li>
            <li>
              Em <em>Environment variables</em>: defina{" "}
              <code className="rounded bg-[#0c1424] px-1.5 py-0.5">ADMIN_TOKEN</code>,{" "}
              <code className="rounded bg-[#0c1424] px-1.5 py-0.5">PUBLIC_URL</code> (
              ex.: <code className="rounded bg-[#0c1424] px-1.5 py-0.5">http://190.89.248.194:3001</code>) e{" "}
              <code className="rounded bg-[#0c1424] px-1.5 py-0.5">HOST_PORT</code>.
            </li>
            <li>Deploy the stack. Coloque atrás de HTTPS (Caddy/Nginx/Traefik) em produção.</li>
          </ol>
        </section>

        <section className="mt-8 rounded-xl border border-[#1f2a3d] bg-[#111c2e] p-8">
          <h2 className="text-xl font-semibold text-[#22d3ee]">Estrutura do ZIP entregue ao cliente</h2>
          <pre className="mt-4 overflow-x-auto rounded-lg border border-[#1f2a3d] bg-[#06101f] p-4 text-xs leading-relaxed text-[#cfe1ff]">
{`historico-whatsapp-<empresa>/
├── index.html        ← duplo-clique abre o visualizador
├── app.js
├── style.css
├── manifest.json
├── README.html
├── data/
│   ├── manifest.js          (window.MANIFEST)
│   ├── chats.js             (window.CHATS)
│   ├── search_index.js      (window.SEARCH_INDEX)
│   └── messages_chat_NNN.js (window.MESSAGES_chat_NNN)
└── media/
    └── chat_NNN/
        ├── imagem.jpg
        ├── audio.ogg
        └── documento.pdf`}
          </pre>
        </section>

        <footer className="mt-10 pb-10 text-center text-xs text-[#8aa0bd]">
          Telenova WhatsApp Archive · uso interno · LGPD-aware · whatsapp-web.js + Puppeteer + Express
        </footer>
      </main>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[#1f2a3d] bg-[#111c2e] p-6">
      <h3 className="text-base font-semibold text-[#22d3ee]">{title}</h3>
      <p className="mt-2 text-sm text-[#cfe1ff]">{children}</p>
    </div>
  );
}
