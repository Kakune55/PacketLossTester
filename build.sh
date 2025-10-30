#!/bin/bash

# 设置程序名称
APP_NAME="package_loss_tester"

# 构建目录
BUILD_DIR="builds"

# 创建构建目录
mkdir -p "$BUILD_DIR"

# 清理旧构建文件
echo "清理旧构建文件..."
rm -rf "$BUILD_DIR"/*
echo "✓ 清理完成"

# 定义目标平台
PLATFORMS=(
    "linux amd64"
    "linux arm64"
    "windows amd64"
    "windows arm64"
    "darwin amd64"
    "darwin arm64"
)

# 编译并压缩单个目标
build_target() {
    local os="$1"
    local arch="$2"

    local output_name="$APP_NAME-$os-$arch"
    local binary="$BUILD_DIR/$output_name"

    # Windows 平台添加 .exe 后缀
    if [ "$os" = "windows" ]; then
        binary="$binary.exe"
    fi

    echo "正在构建 $os/$arch..."

    # 设置环境变量进行交叉编译
    GOOS="$os" GOARCH="$arch" go build -ldflags="-s -w" -o "$binary" .

    if [ $? -eq 0 ]; then
        echo "✓ 构建成功: $binary"

        # 压缩
        compress_binary "$binary" "$os"
    else
        echo "✗ 构建失败: $os/$arch"
        return 1
    fi
}

# 压缩二进制文件
compress_binary() {
    local binary="$1"
    local os="$2"
    local dir=$(dirname "$binary")
    local base=$(basename "$binary")
    local output_dir=$(dirname "$binary")
    local archive_name="${binary%.*}"  # 移除 .exe（如果有）

    local archive_file
    if [ "$os" = "windows" ]; then
        archive_file="$archive_name.zip"
        # 使用 zip 压缩（确保系统已安装 zip）
        zip -j "$archive_file" "$binary" > /dev/null 2>&1
    else
        archive_file="$archive_name.tar.gz"
        # 使用 tar.gz
        tar -C "$dir" -czf "$archive_file" "$base"
    fi

    if [ $? -eq 0 ]; then
        echo "📦 已压缩: $(basename "$archive_file")"
        # 可选：删除原始二进制文件
        # rm -f "$binary"
    else
        echo "⚠️ 压缩失败: $archive_file"
    fi
}

# 生成校验和文件
generate_checksums() {
    local dir="$1"
    local checksum_file="$dir/checksums.txt"

    # 清空旧校验和
    > "$checksum_file"

    # 遍历所有文件（排除 checksums.txt 自身）
    for file in "$dir"/*; do
        if [ -f "$file" ] && [ "$(basename "$file")" != "checksums.txt" ]; then
            sha256sum "$file" >> "$checksum_file"
        fi
    done

    # 转换为 LF 并确保格式正确（避免 Windows CRLF 问题）
    dos2unix "$checksum_file" > /dev/null 2>&1 || true

    echo "✓ 校验和已生成: $checksum_file"
}

# 主流程：遍历所有平台
for platform in "${PLATFORMS[@]}"; do
    set -- $platform
    build_target "$1" "$2"
done

# 生成校验和
echo "正在生成校验和..."
generate_checksums "$BUILD_DIR"

echo "✅ 构建完成！文件位于 '$BUILD_DIR' 目录中。"