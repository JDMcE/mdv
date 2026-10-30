# --- frontend ---
FROM node:22-alpine AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# --- backend ---
FROM golang:1.24-alpine AS server
WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download
COPY cmd/ cmd/
COPY internal/ internal/
COPY --from=web /src/internal/server/dist internal/server/dist
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /mdv ./cmd/mdv

# --- runtime ---
FROM alpine:3.21
RUN apk add --no-cache git openssh-client ca-certificates \
 && adduser -D -u 1000 mdv \
 && mkdir /vault && chown mdv:mdv /vault
COPY --from=server /mdv /usr/local/bin/mdv
USER mdv
ENV MDV_VAULT=/vault MDV_ADDR=:8080
VOLUME /vault
EXPOSE 8080
ENTRYPOINT ["mdv"]
