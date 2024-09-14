# 使用官方的 Go 运行时作为父镜像
FROM golang:1.22-alpine as builder

# 设置工作目录
WORKDIR /app

# 将当前目录下的所有文件复制到容器中的 /app 目录下
COPY . .

# 设置环境变量，避免下载包时需要访问国内无法访问的地址
ENV GOPROXY=https://goproxy.cn

# 构建 Go 应用
RUN go build -o main .

# 使用 Alpine 基础镜像来运行应用，减少最终镜像大小
FROM alpine:3.14

# 安装运行时依赖
RUN apk add --no-cache ca-certificates

# 将之前构建的应用复制到新的镜像中
COPY --from=builder /app/main /app/main
COPY --from=builder /app/static /app/static

# 设置环境变量，指定工作目录
WORKDIR /app

# 暴露端口
EXPOSE 8080

# 启动命令
CMD ["./main"]