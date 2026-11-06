FROM node:22-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev

COPY . .

# Vite inlines VITE_* into the bundle at build time, and .dockerignore excludes
# .env, so the image build cannot read them from a file. They arrive as build
# args instead (see cloudbuild.yaml). These are public identifiers - they ship
# inside the bundle for every visitor regardless. Real secrets (WhatsApp token,
# Daraja keys, the service-account path) are runtime env vars on Cloud Run and
# are deliberately absent here.
ARG VITE_FIREBASE_API_KEY=
ARG VITE_FIREBASE_AUTH_DOMAIN=
ARG VITE_FIREBASE_PROJECT_ID=
ARG VITE_FIREBASE_APP_ID=
ENV VITE_FIREBASE_API_KEY=$VITE_FIREBASE_API_KEY \
    VITE_FIREBASE_AUTH_DOMAIN=$VITE_FIREBASE_AUTH_DOMAIN \
    VITE_FIREBASE_PROJECT_ID=$VITE_FIREBASE_PROJECT_ID \
    VITE_FIREBASE_APP_ID=$VITE_FIREBASE_APP_ID

RUN npm run build && npm prune --omit=dev

FROM node:22-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/server.js ./server.js
COPY --from=build /app/dist ./dist

EXPOSE 8080
CMD ["node", "server.js"]
