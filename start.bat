@echo off
cd /d "%~dp0"
echo Starting WiFi Transfer Server...
start http://localhost:3000
npm start
