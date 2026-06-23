@echo off
REM LocalChat - 命令行客户端 (Windows 便携版)
REM 用法: localchat.bat [--server <host>] [--port <port>]
node "%~dp0cli\index.js" %*
