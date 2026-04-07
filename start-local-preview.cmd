@echo off
setlocal

set "APP_DIR=%~dp0"
set "PORT=3000"

echo Starting local preview at http://localhost:%PORT%
echo Press Ctrl+C to stop the server.
echo.

npx -y serve "%APP_DIR%" -l %PORT% -s
