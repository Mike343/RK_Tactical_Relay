FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY *.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/RKTacticalRelay .

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=build /out/RKTacticalRelay /app/RKTacticalRelay
COPY relay.ini /app/relay.ini
ENV PORT=8787 \
    PUBLIC_IP_LOOKUP=false
EXPOSE 8787 8788
USER 65532:65532
ENTRYPOINT ["/app/RKTacticalRelay"]
