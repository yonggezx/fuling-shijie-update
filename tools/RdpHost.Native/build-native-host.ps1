# ===== Build native desktop-clone host (pure Win32 + COM, no .NET/WinUI) =====
# Usage: powershell -ExecutionPolicy Bypass -File build-native-host.ps1
$ErrorActionPreference = "Stop"
$bt  = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools"
$vt  = Join-Path $bt "VC\Tools\MSVC\14.44.35207"
$kit = "C:\Program Files (x86)\Windows Kits\10"
$inc = Join-Path $kit "Include"
$lib = Join-Path $kit "Lib"
$ver = (Get-ChildItem $inc -Directory | Sort-Object Name -Descending | Select-Object -First 1).Name
$cl  = Join-Path $vt "bin\Hostx64\x64\cl.exe"
if (-not (Test-Path $cl)) { Write-Error "cl.exe not found: $cl"; exit 1 }
$env:INCLUDE = "$vt\include;$inc\$ver\shared;$inc\$ver\ucrt;$inc\$ver\um;$inc\$ver\winrt"
$env:LIB     = "$vt\lib\x64;$lib\$ver\ucrt\x64;$lib\$ver\um\x64"
$env:PATH    = "$vt\bin\Hostx64\x64;$vt\bin\Hostx64\x86;" + $env:PATH
Push-Location $PSScriptRoot
# 编译图标资源（logo-pink.ico / logo.ico）随 exe 内嵌
$rc = Join-Path $kit "bin\$ver\x64\rc.exe"
if (-not (Test-Path $rc)) { Write-Error "rc.exe not found: $rc"; Pop-Location; exit 1 }
& $rc /nologo /fo RdpHostNative.res resources.rc
if ($LASTEXITCODE -ne 0) { Write-Host "[FAIL] rc failed code=$LASTEXITCODE"; Pop-Location; exit $LASTEXITCODE }
& $cl /nologo /EHsc /std:c++17 /O2 /MD /utf-8 /DUNICODE /D_UNICODE RdpHostNative.cpp RdpHostNative.res /Fe:桌面分身.exe /link /SUBSYSTEM:WINDOWS user32.lib gdi32.lib dwmapi.lib ole32.lib oleaut32.lib ws2_32.lib shell32.lib winmm.lib advapi32.lib
$code = $LASTEXITCODE
Pop-Location
if ($code -eq 0) { Write-Host "[OK] build ok: desktop-clone host (桌面分身.exe)" } else { Write-Host "[FAIL] build failed code=$code" }
exit $code