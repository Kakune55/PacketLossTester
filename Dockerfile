# 使用官方的 Go 运行时作为父镜像
FROM golang:1.26.8-alpine AS builder

# 设置工作目录
WORKDIR /app

# 缓存依赖层，源码变更不必重新下载模块
COPY go.mod go.sum ./
RUN go mod download
COPY . .

# 构建 Go 应用
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o main .

# 使用 Alpine 基础镜像来运行应用，减少最终镜像大小
FROM alpine:3.24

# 安装运行时依赖
RUN apk add --no-cache ca-certificates

# 将之前构建的应用复制到新的镜像中
COPY --from=builder /app/main /app/main

# 设置环境变量，指定工作目录
WORKDIR /app

# 暴露端口
EXPOSE 52611

# 启动命令
CMD ["./main"]
