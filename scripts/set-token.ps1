$envPath = Join-Path $PSScriptRoot "..\.env"
$secureInput = Read-Host "Enter Travelpayouts Token" -MaskInput
$token = $secureInput.Trim()
if ($token) {
    $content = Get-Content $envPath
    $newContent = $content -replace "TRAVELPAYOUTS_TOKEN=.*", "TRAVELPAYOUTS_TOKEN=$token"
    Set-Content -Path $envPath -Value $newContent
    Write-Host "Token saved successfully to .env!"
}
