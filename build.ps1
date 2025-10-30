# 设置程序名称
$appName = "package_loss_tester"

# 创建构建目录
New-Item -ItemType Directory -Force -Path "builds" | Out-Null

# 清理旧构建文件
Remove-Item -Path "builds\*" -Force -Recurse -ErrorAction SilentlyContinue

# 定义目标平台
$platforms = @(
    @{ OS = "linux"; Arch = "amd64" },
    @{ OS = "linux"; Arch = "arm64" },
    @{ OS = "windows"; Arch = "amd64" },
    @{ OS = "windows"; Arch = "arm64" },
    @{ OS = "darwin"; Arch = "amd64" },
    @{ OS = "darwin"; Arch = "arm64" }
)

# 交叉编译函数
function Build-Target {
    param (
        [string]$os,
        [string]$arch
    )
    
    $output = "builds\$appName-$os-$arch"
    
    # Windows 平台添加 .exe 后缀
    if ($os -eq "windows") {
        $output += ".exe"
    }
    
    Write-Host "Building for $os/$arch..." -ForegroundColor Yellow
    
    # 记录当前环境变量以便还原
    $prevGOOS = $env:GOOS
    $prevGOARCH = $env:GOARCH

    try {
        # 设置环境变量并编译
        $env:GOOS = $os
        $env:GOARCH = $arch
        go build -ldflags="-s -w" -o $output .
        
        if ($LASTEXITCODE -eq 0) {
            Write-Host "✓ Success: $output" -ForegroundColor Green
        } else {
            Write-Host "✗ Failed: $os/$arch" -ForegroundColor Red
        }
    }
    finally {
        # 还原环境变量（若原本不存在则删除）
        if ($null -eq $prevGOOS) { Remove-Item Env:\GOOS -ErrorAction SilentlyContinue } else { $env:GOOS = $prevGOOS }
        if ($null -eq $prevGOARCH) { Remove-Item Env:\GOARCH -ErrorAction SilentlyContinue } else { $env:GOARCH = $prevGOARCH }
    }
}

# 遍历所有平台进行编译
foreach ($platform in $platforms) {
    Build-Target -os $platform.OS -arch $platform.Arch
}

# 生成校验和文件
Write-Host "Generating checksums..." -ForegroundColor Yellow
Set-Location -Path "builds"
$checksumFile = "checksums.txt"
$files = Get-ChildItem -Exclude $checksumFile

# 清空旧的校验和文件
if (Test-Path $checksumFile) {
    Clear-Content $checksumFile
}

# 为每个文件生成SHA256校验和
foreach ($file in $files) {
    $hash = Get-FileHash -Path $file.FullName -Algorithm SHA256
    "$($hash.Hash.ToLower())  $($file.Name)" | Out-File -FilePath $checksumFile -Append -Encoding UTF8
}

Write-Host "✓ Checksums generated: builds\$checksumFile" -ForegroundColor Green
Set-Location -Path ".."
Write-Host "Build complete! Files are in the 'builds' directory." -ForegroundColor Cyan