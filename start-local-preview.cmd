@echo off
setlocal

set "PORT=3000"
cd /d "%~dp0"

echo Starting local preview at http://localhost:%PORT%
echo Press Ctrl+C to stop the server.
echo.

npx -y serve . -l %PORT% -s
