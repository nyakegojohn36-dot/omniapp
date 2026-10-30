# Hosting SokoFlow and its WhatsApp webhook on Google Cloud Run

The AI Studio deployment serves the SokoFlow frontend. The Express backend runs on Cloud Run, receives Meta webhooks, verifies Firebase ID tokens for app APIs, and stores users, orders, WhatsApp conversations, and chat sessions in Firestore.

## Set up Firebase

Use the same Google Cloud project as the Cloud Run service:

1. Add Firebase to the project and enable **Authentication > Email/Password**.
2. Create a Firestore database in production mode.
3. Deploy the included deny-all client rules (`firebase.json` and `firestore.rules`) before using the app, for example `firebase deploy --only firestore:rules --project <project-id>`. The backend uses the Cloud Run service account and Firebase Admin SDK; browser clients must not read or modify role records directly.
4. Create a Firebase Web App and copy its API key, Auth domain, project ID, and App ID into the AI Studio frontend build environment as `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, and `VITE_FIREBASE_APP_ID`. Add the frontend host to Firebase Authentication's **Authorized domains**. These web app identifiers are public; do not put server secrets in `VITE_` variables.
5. Set `VITE_API_BASE_URL` to the Cloud Run service URL in the AI Studio frontend build environment, and add that exact frontend origin (for example `https://sokoflow.ai.studio`) to the Cloud Run `CORS_ALLOWED_ORIGINS`.
6. Assign the Cloud Run runtime service account the **Cloud Datastore User** role (`roles/datastore.user`) so Firebase Admin can access Firestore.
7. Set `OWNER_EMAIL` on Cloud Run to the primary owner's email. Create that account in the app and verify its email. The verified matching account is assigned the owner role; all self-signups are customers. Owners can assign staff roles to registered users from the workspace.

The app's former browser-only demo personas are not valid accounts. Use Firebase Authentication accounts instead.

## Deploy from Google Cloud Console

1. Open [Cloud Run](https://console.cloud.google.com/run) and select a Google Cloud project with billing enabled. Cloud Run has a monthly free usage allowance, but Google may require a billing account.
2. Select **Deploy container** or **Create service**, then choose the option to deploy from a repository/source and connect the GitHub repository `nyakegojohn36-dot/omniapp`, branch `main`. Configure it to build from the repository's `Dockerfile`.
3. Give the service a name such as `sokoflow-whatsapp`; choose a region close to your customers.
4. Allow unauthenticated invocations so Meta can call the webhook and the app can verify Firebase ID tokens itself. App APIs require a valid Firebase token and server-side Firestore role; CORS only allows configured frontend origins.
5. Add these environment variables to the service:

   | Variable | Value |
   | --- | --- |
   | `WHATSAPP_OPERATING_MODE` | `META_TEST` while testing with Meta's test number |
   | `WHATSAPP_VERIFY_TOKEN` | A new, private random string that you also enter in Meta |
   | `WHATSAPP_APP_SECRET` | The App Secret from Meta App settings |
   | `WHATSAPP_ACCESS_TOKEN` | A current WhatsApp Cloud API access token |
   | `WHATSAPP_PHONE_NUMBER_ID` | The sender's Phone Number ID from Meta API Setup |
   | `WHATSAPP_WABA_ID` | The WhatsApp Business Account ID from Meta |
   | `FIREBASE_PROJECT_ID` | Firebase/Google Cloud project ID |
   | `OWNER_EMAIL` | The verified primary owner's Firebase Authentication email |
   | `DEFAULT_TENANT_ID` | `tenant-nordic` unless you have configured a different tenant |
   | `CORS_ALLOWED_ORIGINS` | Exact comma-separated frontend origins, such as `https://sokoflow.ai.studio` |

   Store the WhatsApp access token, App Secret, and verification token in Secret Manager and attach them as Cloud Run secrets. Do not configure Firebase service-account keys; Cloud Run uses its service account's Application Default Credentials. Never commit secrets or paste them into chat. Rotate any credentials that have previously been shared.

6. Deploy the service and wait until the revision is ready. Cloud Run provides a service URL such as `https://sokoflow-whatsapp-<suffix>-<region>.a.run.app`.
7. Check `https://<cloud-run-service-url>/health` and inspect the secret-safe `whatsapp` and `authentication` flags. For inbound verification, `appSecretConfigured` must be `true`; for replies, `replyConfigurationComplete` must be `true`; Firebase project, owner email, and allowed frontend origins must be configured.
8. In Firebase Console, confirm that the Cloud Run service account has Firestore access and deploy `firestore.rules`. In the frontend, sign up or sign in with Firebase. A request to `/api/orders` without a Firebase token should return `401`; an authenticated owner should be able to open the WhatsApp inbox.
9. In Meta's **WhatsApp > Configuration > Webhooks** settings, enter:
   - **Callback URL:** `https://<cloud-run-service-url>/api/whatsapp/webhook`
   - **Verify token:** the exact value configured as `WHATSAPP_VERIFY_TOKEN`
10. Select **Verify and save**, then subscribe to the `messages` webhook field. The Graph API `/messages` URL is for sending messages and is not the callback URL.

## Notes

- Cloud Run injects the `PORT` environment variable; the Express server listens on it.
- Cloud Run logs contain safe webhook receipt/signature/processing events and outbound Meta API status without message contents, phone numbers, or credentials.
- Cloud Run can scale to zero by default, so the first webhook after an idle period may encounter a cold start. A minimum instance can reduce cold starts but may incur ongoing cost.
- The frontend makes cross-origin API requests to `VITE_API_BASE_URL`; an origin not listed in `CORS_ALLOWED_ORIGINS` is rejected. CORS is not authentication: all app APIs still verify Firebase ID tokens and server-side roles.
- Firestore stores user profiles/roles, orders, WhatsApp messages, sessions, and webhook idempotency records. Do not use publicly writable Firestore rules; owner/staff roles are read and assigned only by the backend.
- Meta webhook requests remain public, but POST requests must have a valid Meta `X-Hub-Signature-256` signature. The separate authenticated `/api/web-chat` endpoint is rate-limited and cannot create WhatsApp orders or dispatch Meta messages.
- See [Cloud Run pricing](https://cloud.google.com/run/pricing) and [Cloud Run deployment from source](https://cloud.google.com/run/docs/deploying-source-code) for current billing and deployment details.
