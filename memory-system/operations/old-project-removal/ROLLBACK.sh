#!/usr/bin/env pwsh
param(
  [string]$Destination = 'D:\book'
)

$ErrorActionPreference = 'Stop'
$source = 'D:\book-old-project-rollback-20260820T1900'
$sourceRoot = (Resolve-Path -LiteralPath $source).Path.TrimEnd('\')
$destinationRoot = [System.IO.Path]::GetFullPath($Destination).TrimEnd('\')

if ($destinationRoot -eq $sourceRoot -or $destinationRoot.StartsWith($sourceRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Rollback destination cannot be inside the backup: $destinationRoot"
}

New-Item -ItemType Directory -Path $destinationRoot -ErrorAction Stop | Out-Null
$sourceItems = Get-ChildItem -LiteralPath $sourceRoot -Force -ErrorAction Stop |
  Where-Object { $_.Name -notin @('ORIGINAL_SHA256.csv', 'ORIGINAL_ROOT.gitignore') }
foreach ($item in $sourceItems) {
  $target = Join-Path $destinationRoot $item.Name
  if (-not $item.PSIsContainer) {
    Copy-Item -LiteralPath $item.FullName -Destination $target -ErrorAction Stop
    continue
  }
  New-Item -ItemType Directory -Path $target -ErrorAction Stop | Out-Null
  foreach ($child in Get-ChildItem -LiteralPath $item.FullName -Recurse -Force -ErrorAction Stop) {
    if ($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { continue }
    $relative = [System.IO.Path]::GetRelativePath($item.FullName, $child.FullName)
    $childTarget = Join-Path $target $relative
    if ($child.PSIsContainer) {
      if (-not (Test-Path -LiteralPath $childTarget)) { New-Item -ItemType Directory -Path $childTarget -ErrorAction Stop | Out-Null }
    } else {
      Copy-Item -LiteralPath $child.FullName -Destination $childTarget -ErrorAction Stop
    }
  }
}
New-Item -ItemType Junction -Path (Join-Path $destinationRoot 'node_modules\@novel-studio\contracts') -Target (Join-Path $destinationRoot 'packages\contracts') -ErrorAction Stop | Out-Null
New-Item -ItemType Junction -Path (Join-Path $destinationRoot 'node_modules\@novel-studio\server') -Target (Join-Path $destinationRoot 'apps\server') -ErrorAction Stop | Out-Null
New-Item -ItemType Junction -Path (Join-Path $destinationRoot 'node_modules\@novel-studio\web') -Target (Join-Path $destinationRoot 'apps\web') -ErrorAction Stop | Out-Null
Copy-Item -LiteralPath (Join-Path $sourceRoot 'ORIGINAL_ROOT.gitignore') -Destination (Join-Path $destinationRoot '.gitignore') -ErrorAction Stop

Write-Output "RESTORED_FROM=$sourceRoot"
Write-Output "RESTORED_TO=$destinationRoot"
Write-Output "ROLLBACK_EXIT=0"
