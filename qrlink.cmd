@echo off
rem qrlint — SendTo entry: decode the dropped image file(s), copy the first link.
rem No arguments opens the GUI instead.
rem ASCII only on purpose: cmd.exe parses .cmd files in the ANSI codepage.
setlocal
set "DIR=%~dp0"
if "%~1"=="" (
  start "" "%DIR%qrlink.vbs"
  exit /b 0
)
python "%DIR%qrlink.py" --first --copy %* 2>&1
echo.
echo --- the line above is now on your clipboard ---
rem let the console linger a moment (ping, not timeout: Git's timeout may shadow it)
ping -n 9 127.0.0.1 >nul 2>&1
