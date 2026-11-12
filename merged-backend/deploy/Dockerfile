# 多阶段构建：Go 静态二进制 → scratch 极简镜像
# 构建命令：docker build -f deploy/Dockerfile -t waterlog-backend .
FROM golang:1.22-alpine AS build
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags='-s -w' -o waterlog-server ./cmd/server

FROM scratch
WORKDIR /app
COPY --from=build /app/waterlog-server /app/waterlog-server
# 如需时区支持，可取消下面注释：
# COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
ENV DB_PATH=/data/app.db
ENV ADDR=:8080
EXPOSE 8080
ENTRYPOINT ["/app/waterlog-server"]
