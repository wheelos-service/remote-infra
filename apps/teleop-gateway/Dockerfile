FROM golang:1.24-alpine3.20 AS build
ARG GOPROXY=https://proxy.golang.org,direct
ENV GOPROXY=$GOPROXY
RUN apk add --no-cache git
WORKDIR /src
# copy module files first to leverage Docker layer cache for dependency download
COPY go.mod go.sum* ./
RUN go mod download
# copy rest of source
COPY . .
# static build for smaller, portable binary
RUN CGO_ENABLED=0 GOOS=linux go build -mod=readonly -trimpath -ldflags "-s -w" -o /teleop-backend ./cmd/teleop-gateway \
    && CGO_ENABLED=0 GOOS=linux go build -mod=readonly -trimpath -ldflags "-s -w" -o /auth-admin ./cmd/auth-admin

FROM alpine:3.20
RUN apk add --no-cache ca-certificates && addgroup -S app && adduser -S app -G app \
    && mkdir -p /var/lib/teleop && chown app:app /var/lib/teleop \
    && chmod 0700 /var/lib/teleop
COPY --from=build /teleop-backend /usr/local/bin/teleop-backend
COPY --from=build /auth-admin /usr/local/bin/auth-admin
ENV OPERATIONS_DB_PATH=/var/lib/teleop/operations.db
USER app
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/teleop-backend"]
