$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location -Path $ScriptDir

# ---------------------------------------------------------------------------
# FFmpeg 工具容器（首帧缩略图等能力的前置条件之一）
# - 默认：若已安装 Docker，则检查 modeltoosd-ffmpeg-tools 是否在运行；
#   若不存在或未运行，自动执行 docker compose -f docker-compose.ffmpeg.yml up -d。
#   后续可由 Node 通过 `docker exec modeltoosd-ffmpeg-tools ffmpeg ...` 调用。
# - 无法使用 Docker 时：设置环境变量 MODELTOOSD_SKIP_DOCKER_FFMPEG=1 再运行本脚本。
# - 停止工具容器：docker compose -f docker-compose.ffmpeg.yml down
# ---------------------------------------------------------------------------
$ffmpegContainerName = 'modeltoosd-ffmpeg-tools'
$skipFfmpegDocker = $env:MODELTOOSD_SKIP_DOCKER_FFMPEG -eq '1'
if (-not $skipFfmpegDocker) {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        Write-Host '错误: 未检测到 Docker。安装 Docker Desktop 后重试，或设置 MODELTOOSD_SKIP_DOCKER_FFMPEG=1 跳过（首帧/FFmpeg 相关能力将不可用）。' -ForegroundColor Red
        exit 1
    }
    $composeFile = Join-Path $ScriptDir 'docker-compose.ffmpeg.yml'
    if (-not (Test-Path -LiteralPath $composeFile)) {
        Write-Host ('错误: 缺少 ' + $composeFile) -ForegroundColor Red
        exit 1
    }
    $runningFlag = docker container inspect -f '{{.State.Running}}' $ffmpegContainerName 2>$null
    $inspectOk = ($LASTEXITCODE -eq 0) -and ($runningFlag -eq 'true')
    if ($inspectOk) {
        Write-Host ('FFmpeg 容器已在运行: ' + $ffmpegContainerName) -ForegroundColor Green
    } else {
        Write-Host '未检测到运行中的 FFmpeg 容器，正在拉取/启动 docker compose up -d ...' -ForegroundColor Cyan
        $composeAttempts = 3
        $composeDelaySec = 6
        $composeOk = $false
        for ($i = 1; $i -le $composeAttempts; $i++) {
            docker compose -f $composeFile up -d
            if ($LASTEXITCODE -eq 0) {
                $composeOk = $true
                break
            }
            if ($i -lt $composeAttempts) {
                Write-Host ('docker compose 失败，' + $composeDelaySec + ' 秒后重试 (' + $i + '/' + $composeAttempts + ')...') -ForegroundColor Yellow
                Start-Sleep -Seconds $composeDelaySec
            }
        }
        if (-not $composeOk) {
            Write-Host '错误: FFmpeg 工具容器启动失败（请检查 Docker 是否已运行、网络与镜像/软件源是否可达）。' -ForegroundColor Red
            exit 1
        }
        $runningFlag = docker container inspect -f '{{.State.Running}}' $ffmpegContainerName 2>$null
        if (($LASTEXITCODE -ne 0) -or ($runningFlag -ne 'true')) {
            Write-Host ('错误: 部署后容器仍未运行。请手动检查: docker compose -f ' + $composeFile + ' ps -a') -ForegroundColor Red
            exit 1
        }
        Write-Host ('FFmpeg 容器已就绪: ' + $ffmpegContainerName) -ForegroundColor Green
    }
} else {
    Write-Host '已跳过 FFmpeg Docker 容器 (MODELTOOSD_SKIP_DOCKER_FFMPEG=1)' -ForegroundColor Yellow
}

Write-Host 'Starting ModelTooSD Development Server...' -ForegroundColor Cyan
npm run dev
