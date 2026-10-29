# Hosting the WhatsApp webhook

The AI Studio deployment serves the SokoFlow frontend. Meta webhooks need a public HTTPS endpoint running the Node.js/Express server in `server.ts`.

## Deploy a webhook-only service on Render

Create a Render **Web Service** from this GitHub repository and configure:

- **Build command:** `npm install --include=dev && npm run build`
- **Start command:** `npm start`
- **Health check path:** `/health`

Set these environment variables in Render's environment settings:

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `WHATSAPP_WEBHOOK_ONLY` | `true` |
| `WHATSAPP_OPERATING_MODE` | `META_TEST` while testing with Meta's test number |
| `WHATSAPP_VERIFY_TOKEN` | A new, private random string that you also enter in Meta |
| `WHATSAPP_APP_SECRET` | The App Secret from Meta App settings |
| `WHATSAPP_ACCESS_TOKEN` | A current WhatsApp Cloud API access token |
| `WHATSAPP_PHONE_NUMBER_ID` | The sender's Phone Number ID from Meta API Setup |
| `WHATSAPP_WABA_ID` | The WhatsApp Business Account ID from Meta |

Use Render's secret environment-variable fields for the token, App Secret, and verification token. Never add those values to Git or paste them into chat. Rotate any credentials that have previously been shared.

After deployment, the service health check should pass at `https://<your-service>.onrender.com/health`. In Meta's **WhatsApp > Configuration > Webhooks** settings, enter:

- **Callback URL:** `https://<your-service>.onrender.com/api/whatsapp/webhook`
- **Verify token:** the exact value configured as `WHATSAPP_VERIFY_TOKEN`

Select **Verify and save**, then subscribe to the `messages` webhook field. The Graph API `/messages` URL is for sending messages and is not the callback URL.

## Webhook-only mode limitations

In production, the server restricts API access to the webhook handshake, signed webhook POSTs, and `/health`; other `/api` routes return 404. This keeps the current demo configuration, order, and message APIs from being exposed without authentication. The AI Studio frontend will not share this service's in-memory messages or orders. Connecting the full owner inbox requires proper user authentication and persistent storage before those APIs can be safely enabled.
