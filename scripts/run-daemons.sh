#!/usr/bin/env bash
# 三进程守护管理脚本:gateway + proactive + drift。
#
# 用法:
#   scripts/run-daemons.sh start    # 启动全部三个进程(nohup,日志在 .run/logs/)
#   scripts/run-daemons.sh status   # 查看三个进程状态
#   scripts/run-daemons.sh stop     # 停止三个进程
#   scripts/run-daemons.sh logs     # 实时查看三个日志(tail -f)
#   scripts/run-daemons.sh <name>   # 单进程操作:start/stop/status/logs 之一 + 名称
#
# 环境:
#   COGITO_CODING_AGENT_DIR 指向可写的 agent 目录(沙箱中 ~/.cogito 只读时用副本)。
#   proactive.json 默认读 .run/proactive.json;driftDir 默认 .run/agent/drift。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT/.run"
LOG_DIR="$RUN_DIR/logs"
AGENT_DIR="${COGITO_CODING_AGENT_DIR:-$HOME/.cogito/agent}"
PROACTIVE_CONFIG="${PROACTIVE_CONFIG:-$RUN_DIR/proactive.json}"
DRIFT_DIR="${DRIFT_DIR:-$AGENT_DIR/drift}"

mkdir -p "$LOG_DIR"

declare -A PIDS
PIDS[gateway]=""
PIDS[proactive]=""
PIDS[drift]=""

find_pid() {
	local name="$1"
	if [ -f "$LOG_DIR/$name.pid" ]; then
		local pid
		pid="$(cat "$LOG_DIR/$name.pid" 2>/dev/null || true)"
		if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
			echo "$pid"
			return 0
		fi
	fi
	# 兜底:按命令行匹配
	case "$name" in
		gateway) pgrep -f "scripts/cogito-gateway.ts" | head -1 || true ;;
		proactive) pgrep -f "packages/proactive/scripts/daemon.ts" | head -1 || true ;;
		drift) pgrep -f "packages/drift/scripts/daemon.ts" | head -1 || true ;;
	esac
}

start_one() {
	local name="$1"
	local existing
	existing="$(find_pid "$name")"
	if [ -n "$existing" ]; then
		echo "$name already running (pid $existing)"
		return 0
	fi
	case "$name" in
		gateway)
			(cd "$ROOT" && nohup node --import tsx scripts/cogito-gateway.ts >"$LOG_DIR/gateway.log" 2>&1 & echo $! >"$LOG_DIR/gateway.pid")
			;;
		proactive)
			(cd "$ROOT" && COGITO_CODING_AGENT_DIR="$AGENT_DIR" nohup node --import tsx packages/proactive/scripts/daemon.ts "$PROACTIVE_CONFIG" >"$LOG_DIR/proactive.log" 2>&1 & echo $! >"$LOG_DIR/proactive.pid")
			;;
		drift)
			(cd "$ROOT" && COGITO_CODING_AGENT_DIR="$AGENT_DIR" nohup node --import tsx packages/drift/scripts/daemon.ts "$DRIFT_DIR" >"$LOG_DIR/drift.log" 2>&1 & echo $! >"$LOG_DIR/drift.pid")
			;;
		*)
			echo "unknown daemon: $name" >&2
			return 1
			;;
	esac
	echo "$name started (pid $(cat "$LOG_DIR/$name.pid"))"
}

stop_one() {
	local name="$1"
	local pid
	pid="$(find_pid "$name")"
	if [ -z "$pid" ]; then
		echo "$name not running"
		return 0
	fi
	kill "$pid" 2>/dev/null || true
	echo "$name stopped (pid $pid)"
}

status_one() {
	local name="$1"
	local pid
	pid="$(find_pid "$name")"
	if [ -n "$pid" ]; then
		echo "$name: RUNNING (pid $pid)"
	else
		echo "$name: stopped"
	fi
}

case "${1:-status}" in
	start)
		for name in gateway proactive drift; do start_one "$name"; done
		;;
	stop)
		for name in drift proactive gateway; do stop_one "$name"; done
		;;
	status)
		for name in gateway proactive drift; do status_one "$name"; done
		;;
	logs)
		tail -f "$LOG_DIR/gateway.log" "$LOG_DIR/proactive.log" "$LOG_DIR/drift.log"
		;;
	gateway|proactive|drift)
		# 单进程:scripts/run-daemons.sh proactive start
		local action="${2:-status}"
		case "$action" in
			start) start_one "$1" ;;
			stop) stop_one "$1" ;;
			status) status_one "$1" ;;
			logs) tail -f "$LOG_DIR/$1.log" ;;
			*) echo "usage: $0 $1 [start|stop|status|logs]" >&2; exit 1 ;;
		esac
		;;
	*)
		echo "usage: $0 [start|stop|status|logs|gateway|proactive|drift]" >&2
		exit 1
		;;
esac
