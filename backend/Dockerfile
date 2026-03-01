FROM golang:1.24-alpine AS build
# Use GOPROXY to improve dependency download reliability
ENV GOPROXY=https://goproxy.cn,direct
RUN apk add --no-cache git
WORKDIR /src
# copy module files first to leverage Docker layer cache for dependency download
COPY go.mod go.sum* ./
RUN go env -w GOPROXY=$GOPROXY && go mod download
# copy rest of source
COPY . .
# ensure module requirements are populated and deps downloaded
RUN go mod tidy
# static build for smaller, portable binary
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags "-s -w" -o /teleop-backend ./

FROM alpine:3.18
RUN addgroup -S app && adduser -S app -G app
COPY --from=build /teleop-backend /usr/local/bin/teleop-backend
USER app
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/teleop-backend"]
