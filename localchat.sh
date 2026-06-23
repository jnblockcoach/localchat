#!/usr/bin/env bash
# LocalChat - 命令行客户端 (Unix 便携版)
# 用法: ./localchat.sh [--server <host>] [--port <port>]
DIR="$(cd "$(dirname "$0")" && pwd)"
node "$DIR/cli/index.js" "$@"
