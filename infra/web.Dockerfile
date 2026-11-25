# syntax=docker/dockerfile:1.7
# ── FieldSync web tier: build the PWA, serve it with unprivileged nginx ─────────
FROM node:22-alpine AS build
WORKDIR /src
COPY contracts ./contracts
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN cd frontend && npm ci --no-audit --no-fund --ignore-scripts
COPY frontend ./frontend
RUN cd frontend && npm run build:bundle

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY infra/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY infra/nginx/snippets /etc/nginx/snippets
COPY --from=build /src/frontend/dist /usr/share/nginx/html
EXPOSE 8080
