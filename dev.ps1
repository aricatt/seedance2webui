$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location -Path $ScriptDir

Write-Host "Starting ModelTooSD Development Server..." -ForegroundColor Cyan
npm run dev
