FROM golang:1.27.4-alpine3.24@sha256:70bd7ddea8b6cbe5d6943cde279d6b67feb10cc924fb9100d1d8757c1575b280 AS builder
ARG GOPROXY
ENV GOTOOLCHAIN=local CGO_ENABLED=0 PATH="/go/bin:${PATH}"
RUN apk add --no-cache bash git
WORKDIR /src
RUN git clone --branch master --no-checkout --depth 1 https://github.com/livekit/livekit && \
    cd livekit && git fetch --depth 1 origin c5c8ec507dfec495e89eb64a3370645473d4f6b7 && \
    git checkout --detach c5c8ec507dfec495e89eb64a3370645473d4f6b7
WORKDIR /src/livekit
RUN ./bootstrap.sh && mage && \
    go test ./pkg/sfu/packettrailer ./pkg/sfu -run 'Test(StripTrailer|DownTrackReplaysPacketTrailerStripOnRetransmit)'

FROM alpine:3.24.4@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf
RUN apk upgrade --no-cache
LABEL org.opencontainers.image.source="https://github.com/livekit/livekit" \
      org.opencontainers.image.revision="c5c8ec507dfec495e89eb64a3370645473d4f6b7"
COPY --from=builder /src/livekit/bin/livekit-server /livekit-server
ENTRYPOINT ["/livekit-server"]
