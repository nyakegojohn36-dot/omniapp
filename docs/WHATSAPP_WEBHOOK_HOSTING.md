# Hosting the WhatsApp webhook on Google Cloud Run

The AI Studio deployment serves the SokoFlow frontend. Meta webhooks need a public HTTPS endpoint running the Node.js/Express backend. This repository now includes a Dockerfile for Cloud Run.

## Deploy from Google Cloud Console

1. Open [Cloud Run](https://console.cloud.google.com/run) and select a Google Cloud project with billing enabled. Cloud Run has a monthly free usage allowance, but Google may require a billing account.
2. Select **Deploy container** or **Create service**, then choose the option to deploy from a repository/source and connect the GitHub repository `nyakegojohn36-dot/omniapp`, branch `main`. Configure it to build from the repository's `Dockerfile`.
3. Give the service a name such as `sokoflow-whatsapp`; choose a region close to your customers.
4. Allow unauthenticated invocations so Meta can call the webhook. The app restricts production API routes to the webhook and health check; do not remove that restriction until the owner APIs have real authentication.
5. Add these environment variables to the service:

   | Variable | Value |
   | --- | --- |
   | `WHATSAPP_WEBHOOK_ONLY` | `true` |
   | `WHATSAPP_OPERATING_MODE` | `META_TEST` while testing with Meta's test number |
   | `WHATSAPP_VERIFY_TOKEN` | A new, private random string that you also enter in Meta |
   | `WHATSAPP_APP_SECRET` | The App Secret from Meta App settings |
   | `WHATSAPP_ACCESS_TOKEN` | A current WhatsApp Cloud API access token |
   | `WHATSAPP_PHONE_NUMBER_ID` | The sender's Phone Number ID from Meta API Setup |
   | `WHATSAPP_WABA_ID` | The WhatsApp Business Account ID from Meta |

   Store the access token, App Secret, and verification token in Secret Manager and attach them as Cloud Run secrets when possible. Never commit secrets or paste them into chat. Rotate any credentials that have previously been shared.

6. Deploy the service and wait until the revision is ready. Cloud Run provides a service URL such as `https://sokoflow-whatsapp-<suffix>-<region>.a.run.app`.
7. Check `https://<cloud-run-service-url>/health` returns `{"status":"ok"}` and inspect the secret-safe `whatsapp` flags. For inbound verification, `appSecretConfigured` must be `true`; for automated replies, `replyConfigurationComplete` must be `true`.
8. In Meta's **WhatsApp > Configuration > Webhooks** settings, enter:
   - **Callback URL:** `https://<cloud-run-service-url>/api/whatsapp/webhook`
   - **Verify token:** the exact value configured as `WHATSAPP_VERIFY_TOKEN`
9. Select **Verify and save**, then subscribe to the `messages` webhook field. The Graph API `/messages` URL is for sending messages and is not the callback URL.

## Notes

- Cloud Run injects the `PORT` environment variable; the Express server listens on it.
- Cloud Run logs contain safe webhook receipt/signature/processing events and outbound Meta API status without message contents, phone numbers, or credentials.
- Cloud Run can scale to zero by default, so the first webhook after an idle period may encounter a cold start. A minimum instance can reduce cold starts but may incur ongoing cost.
- This service is configured as a webhook backend, not a fully connected owner dashboard. In production, the demo configuration/order/message APIs are blocked. The AI Studio frontend will not share this service's in-memory messages or orders; connecting the full inbox requires real authentication and persistent storage.
- See [Cloud Run pricing](https://cloud.google.com/run/pricing) and [Cloud Run deployment from source](https://cloud.google.com/run/docs/deploying-source-code) for current billing and deployment details.
