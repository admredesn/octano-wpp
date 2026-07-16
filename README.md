# octano-wpp — Gateway WhatsApp da rede Octano

Node + [Baileys](https://github.com/WhiskeySockets/Baileys). Emula o WhatsApp Web,
expõe uma API REST e **persiste a sessão no Supabase** (sobrevive a redeploy do Railway).
O núcleo dos postos e o retaguarda usam este serviço para enviar mensagens.

## Endpoints
- `GET /status` → `{ ok, connected, numero, session }`
- `GET /qr` → `{ ok, connected, qr }` (qr = data URL de imagem PNG; escaneie no WhatsApp)
- `POST /send-text` (header `X-Wpp-Token`) → body `{ phone, message }`
- `POST /send-image` (header `X-Wpp-Token`) → body `{ phone, image, caption }` (image = base64 ou data URL)

`phone` aceita `31999998888` / `5531999998888` (normaliza para 55+DDD+número).

## Variáveis de ambiente (Railway → Variables)
- `SUPABASE_URL` = https://gnlbkwvoqnncpszmokuv.supabase.co
- `SUPABASE_SERVICE_KEY` = (service_key do Supabase)
- `WPP_TOKEN` = (um segredo forte — exigido no header X-Wpp-Token para enviar)
- `WPP_SESSION` = `rede` (padrão; use outro se quiser mais de um número)
- `PORT` = (o Railway injeta sozinho)

## Migração
Rode `migracao-wpp.sql` no Supabase (cria `oct_wpp_sessao` e `oct_wpp_status`).

## Deploy (Railway)
1. New Project → Deploy from GitHub repo → `admredesn/octano-wpp`.
2. Adicione as Variables acima.
3. Deploy. Abra `GET /qr` (ou a tela do retaguarda) e escaneie o QR com o WhatsApp do número da rede.
4. Conectado, `GET /status` mostra `connected:true`.

## Risco
Automação por biblioteca não-oficial viola os termos do WhatsApp e pode **bloquear o número**.
Use um **número dedicado** da rede, não pessoal, e mantenha o volume moderado.
