FROM golang:1.24-alpine AS build
ENV GOPROXY=https://goproxy.cn,direct
RUN apk add --no-cache git
WORKDIR /src
COPY go.mod go.sum* ./
RUN go env -w GOPROXY=$GOPROXY && go mod download
COPY . .
RUN go mod tidy
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags "-s -w" -o /teleop-backend ./

FROM alpine:3.18
RUN addgroup -S app && adduser -S app -G app
COPY --from=build /teleop-backend /usr/local/bin/teleop-backend
USER app
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/teleop-backend"]
