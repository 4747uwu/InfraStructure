@echo off
:: Starts Router Hub: MongoDB (if not already running) and the web app.
cd /d "%~dp0"
node tools\start.mjs
pause
