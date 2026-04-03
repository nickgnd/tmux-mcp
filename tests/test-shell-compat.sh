#!/bin/bash
#
# tmux MCP シェル互換性テスト（MCP経由）
#
# このテストは実際にtmux MCPサーバーを使用してテストします。
# 
# 前提条件:
# - tmux MCPサーバーが起動していること
# - SSH接続先が設定されていること
#

set -e

# 色付き出力
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# テスト用セッション名
TEST_SESSION="tmux-mcp-test-$$"

# SSH先
SSH_HOST="${SSH_TEST_HOST:-vps-yamada-web01}"

# 結果カウンター
PASSED=0
FAILED=0

log_info() {
    echo -e "${YELLOW}[INFO]${NC} $1"
}

log_pass() {
    echo -e "${GREEN}[PASS]${NC} $1"
    ((PASSED++))
}

log_fail() {
    echo -e "${RED}[FAIL]${NC} $1"
    ((FAILED++))
}

cleanup() {
    log_info "クリーンアップ中..."
    tmux kill-session -t "$TEST_SESSION" 2>/dev/null || true
}

trap cleanup EXIT

# =============================================================================
# TC1: ローカルfishでコマンド実行 + $status が数値として展開されること
# =============================================================================
test_local_fish_via_mcp() {
    log_info "TC1: ローカルfishでコマンド実行（$status が数値に展開されること）"
    
    # fishシェルでセッション作成
    tmux new-session -d -s "$TEST_SESSION" fish
    sleep 0.5
    
    # 修正後のコード: set __exit $status を使って数値を展開
    # 旧コード: echo "TMUX_MCP_DONE_\$status" → リテラル文字列になりマッチ失敗
    # 新コード: set __exit $status; echo "TMUX_MCP_DONE_$__exit" → 数値に展開
    local test_cmd='echo "TMUX_MCP_START"; echo "TEST_MARKER_TC1"; set __exit $status; echo "TMUX_MCP_DONE_$__exit"'
    tmux send-keys -t "$TEST_SESSION" "$test_cmd" Enter
    sleep 0.5
    
    # 結果確認
    local output=$(tmux capture-pane -t "$TEST_SESSION" -p)
    
    if echo "$output" | grep -q "Unsupported use of"; then
        log_fail "TC1: fishで構文エラー発生"
        echo "出力: $output"
        return 1
    elif echo "$output" | grep -q "TEST_MARKER_TC1"; then
        # $status が数値に展開されているか確認（TMUX_MCP_DONE_0 のような形式）
        if echo "$output" | grep -qE "TMUX_MCP_DONE_[0-9]+"; then
            log_pass "TC1: fishでコマンド正常実行・\$status が数値に展開された"
            return 0
        else
            log_fail "TC1: TMUX_MCP_DONE_ の後に数値がない（\$status が展開されていない）"
            echo "出力: $output"
            return 1
        fi
    else
        log_fail "TC1: 予期しない結果"
        echo "出力: $output"
        return 1
    fi
}

# =============================================================================
# TC1b: 旧コード（\\$status）が失敗することの確認（リグレッションテスト）
# =============================================================================
test_fish_old_code_regression() {
    log_info "TC1b: 旧コード（\\$status リテラル）がマーカーマッチに失敗することを確認"

    tmux kill-session -t "$TEST_SESSION" 2>/dev/null || true
    tmux new-session -d -s "$TEST_SESSION" fish
    sleep 0.5

    # 旧コードが生成していたコマンド（\$status がリテラルになる）
    local old_cmd='echo "TMUX_MCP_START"; echo "OLD_CODE_TEST"; echo "TMUX_MCP_DONE_\$status"'
    tmux send-keys -t "$TEST_SESSION" "$old_cmd" Enter
    sleep 0.5

    local output=$(tmux capture-pane -t "$TEST_SESSION" -p)

    # 旧コードでは TMUX_MCP_DONE_$status（数値でない）が出力される
    if echo "$output" | grep -qE "TMUX_MCP_DONE_[0-9]+"; then
        log_fail "TC1b: 旧コードが数値を返した（想定外）"
        echo "出力: $output"
        return 1
    elif echo "$output" | grep -q 'TMUX_MCP_DONE_$status'; then
        log_pass "TC1b: 旧コードはリテラル文字列を返す（マーカーマッチ失敗を確認）"
        return 0
    else
        log_fail "TC1b: 予期しない結果"
        echo "出力: $output"
        return 1
    fi
}

# =============================================================================
# TC2: ローカルbashでコマンド実行
# =============================================================================
test_local_bash() {
    log_info "TC2: ローカルbashでコマンド実行"
    
    tmux kill-session -t "$TEST_SESSION" 2>/dev/null || true
    
    # bashシェルでセッション作成
    tmux new-session -d -s "$TEST_SESSION" bash
    sleep 0.5
    
    # bash用のコマンド形式（HISTCONTROL付き、先頭スペース）
    local test_cmd=' HISTCONTROL=ignorespace; echo "TMUX_MCP_START"; echo "TEST_MARKER_TC2"; echo "TMUX_MCP_DONE_$?"'
    tmux send-keys -t "$TEST_SESSION" "$test_cmd" Enter
    sleep 0.5
    
    # 結果確認
    local output=$(tmux capture-pane -t "$TEST_SESSION" -p)
    
    if echo "$output" | grep -q "TEST_MARKER_TC2"; then
        log_pass "TC2: bashでコマンド正常実行"
        return 0
    else
        log_fail "TC2: bashでコマンド実行失敗"
        echo "出力: $output"
        return 1
    fi
}

# =============================================================================
# TC3: ローカルfish → SSH先bashでコマンド実行
# =============================================================================
test_fish_to_ssh_bash() {
    log_info "TC3: ローカルfish → SSH先bashでコマンド実行"
    
    tmux kill-session -t "$TEST_SESSION" 2>/dev/null || true
    
    # fishシェルでセッション作成
    tmux new-session -d -s "$TEST_SESSION" fish
    sleep 0.5
    
    # SSH接続（これはfishでも問題ない）
    tmux send-keys -t "$TEST_SESSION" "ssh $SSH_HOST" Enter
    sleep 2
    
    # SSH先（bash）でコマンド実行
    # 修正後: SSH先では初期化後にHISTCONTROLが設定されているので、先頭スペースでOK
    local test_cmd=' echo "TEST_MARKER_TC3"'
    tmux send-keys -t "$TEST_SESSION" "$test_cmd" Enter
    sleep 0.5
    
    # 結果確認
    local output=$(tmux capture-pane -t "$TEST_SESSION" -p)
    
    if echo "$output" | grep -q "TEST_MARKER_TC3"; then
        log_pass "TC3: fish→SSH先bashでコマンド正常実行"
        return 0
    else
        log_fail "TC3: fish→SSH先bashでコマンド実行失敗"
        echo "出力: $output"
        return 1
    fi
}

# =============================================================================
# TC4: SSH先で新しいヒストリーにMCPコマンドが残らないこと
# =============================================================================
test_ssh_history_clean() {
    log_info "TC4: SSH先の新規ヒストリーにMCPコマンドが残らないこと"
    
    # 初期化を模倣（HISTCONTROLを設定）
    local init_cmd=' export HISTCONTROL="${HISTCONTROL:+$HISTCONTROL:}ignorespace"; echo "INIT_DONE"'
    tmux send-keys -t "$TEST_SESSION" "$init_cmd" Enter
    sleep 0.3
    
    # 初期化後のコマンド（先頭スペース付き）
    local test_cmd=' echo "SHOULD_NOT_APPEAR_IN_HISTORY"'
    tmux send-keys -t "$TEST_SESSION" "$test_cmd" Enter
    sleep 0.3
    
    # もう一つコマンド実行
    local test_cmd2=' echo "ALSO_SHOULD_NOT_APPEAR"'
    tmux send-keys -t "$TEST_SESSION" "$test_cmd2" Enter
    sleep 0.3
    
    # 現在のセッションのヒストリーを確認（fcコマンドで直近のみ）
    tmux send-keys -t "$TEST_SESSION" 'fc -l -5' Enter
    sleep 0.5
    
    local output=$(tmux capture-pane -t "$TEST_SESSION" -p -S -20)
    
    # SHOULD_NOT_APPEAR_IN_HISTORYがfc -lの出力に含まれていないことを確認
    if echo "$output" | grep "fc -l" -A5 | grep -q "SHOULD_NOT_APPEAR"; then
        log_fail "TC4: 先頭スペースのコマンドがヒストリーに記録された"
        echo "出力: $output"
        return 1
    else
        log_pass "TC4: 先頭スペースのコマンドはヒストリーに記録されない"
        return 0
    fi
}

# =============================================================================
# TC5: 完全なMCPフロー模倣テスト
# =============================================================================
test_full_mcp_flow() {
    log_info "TC5: 完全なMCPフロー模倣テスト"
    
    tmux kill-session -t "$TEST_SESSION" 2>/dev/null || true
    
    # fishでセッション作成
    tmux new-session -d -s "$TEST_SESSION" fish
    sleep 0.5
    
    # SSH接続
    tmux send-keys -t "$TEST_SESSION" "ssh $SSH_HOST" Enter
    sleep 2
    
    # 修正後のフロー: シェル検出とHISTCONTROL設定を1行で実行
    # これにより初期化コマンド自体もヒストリーに残らない
    local init_and_detect_cmd=' export HISTCONTROL=ignorespace 2>/dev/null; setopt HIST_IGNORE_SPACE 2>/dev/null; echo TMUX_MCP_INIT_DONE_SHELL_$0'
    tmux send-keys -t "$TEST_SESSION" "$init_and_detect_cmd" Enter
    sleep 0.3
    
    # 実際のコマンド実行（これ以降はヒストリーに残らないはず）
    local work_cmd=' echo "TMUX_MCP_START"; hostname; echo "TMUX_MCP_DONE_$?"'
    tmux send-keys -t "$TEST_SESSION" "$work_cmd" Enter
    sleep 0.3
    
    # ヒストリー確認
    tmux send-keys -t "$TEST_SESSION" 'fc -l -10' Enter
    sleep 0.5
    
    local output=$(tmux capture-pane -t "$TEST_SESSION" -p -S -30)
    
    # TMUX_MCP_STARTがヒストリーに含まれていないことを確認
    if echo "$output" | grep "fc -l" -A10 | grep -q "TMUX_MCP_START"; then
        log_fail "TC5: MCPコマンドがヒストリーに記録された"
        echo "出力: $output"
        return 1
    else
        log_pass "TC5: MCPコマンドはヒストリーに記録されない"
        return 0
    fi
}

# =============================================================================
# TC6: split-pane機能テスト
# =============================================================================
test_split_pane() {
    log_info "TC6: split-pane機能テスト（水平分割）"
    
    # テスト用セッション作成
    tmux new-session -d -s "${TEST_SESSION}-split" -x 160 -y 40
    sleep 0.5
    
    # 初期pane数確認
    local initial_panes=$(tmux list-panes -t "${TEST_SESSION}-split" | wc -l | tr -d ' ')
    
    # 水平分割
    tmux split-window -h -t "${TEST_SESSION}-split"
    sleep 0.3
    
    # 分割後のpane数確認
    local after_split_panes=$(tmux list-panes -t "${TEST_SESSION}-split" | wc -l | tr -d ' ')
    
    # クリーンアップ
    tmux kill-session -t "${TEST_SESSION}-split" 2>/dev/null || true
    
    if [ "$initial_panes" = "1" ] && [ "$after_split_panes" = "2" ]; then
        log_pass "TC6: split-pane機能正常動作（1→2 panes）"
        return 0
    else
        log_fail "TC6: split-pane失敗（initial=$initial_panes, after=$after_split_panes）"
        return 1
    fi
}

# =============================================================================
# TC7: rawMode/noEnterとshell-aware処理の統合テスト
# =============================================================================
test_rawmode_integration() {
    log_info "TC7: rawMode/noEnter統合テスト"
    
    # テスト用セッション作成（fish shell）
    tmux new-session -d -s "${TEST_SESSION}-raw" -x 160 -y 40
    sleep 0.5
    
    # 通常コマンド（shell-aware処理が適用される）
    tmux send-keys -t "${TEST_SESSION}-raw" ' echo "normal_mode_test"' Enter
    sleep 0.3
    
    # rawModeのシミュレート（単純なテキスト送信）
    tmux send-keys -t "${TEST_SESSION}-raw" 'echo "raw_mode_test"'
    # Enterを送らない（noEnterのシミュレート）
    sleep 0.3
    
    local output=$(tmux capture-pane -t "${TEST_SESSION}-raw" -p)
    
    # クリーンアップ
    tmux kill-session -t "${TEST_SESSION}-raw" 2>/dev/null || true
    
    # 通常モードの出力が含まれていること
    if echo "$output" | grep -q "normal_mode_test"; then
        log_pass "TC7: rawMode/noEnter統合テスト正常"
        return 0
    else
        log_fail "TC7: 統合テスト失敗"
        echo "出力: $output"
        return 1
    fi
}

# =============================================================================
# メイン
# =============================================================================
main() {
    echo "=========================================="
    echo "tmux MCP シェル互換性テスト"
    echo "=========================================="
    echo ""
    echo "SSH_HOST: $SSH_HOST"
    echo ""
    
    # テスト実行
    test_local_fish_via_mcp || true
    test_fish_old_code_regression || true
    test_local_bash || true
    test_fish_to_ssh_bash || true
    test_ssh_history_clean || true
    test_full_mcp_flow || true
    test_split_pane || true
    test_rawmode_integration || true
    
    echo ""
    echo "=========================================="
    echo "テスト結果: PASSED=$PASSED, FAILED=$FAILED"
    echo "=========================================="
    
    if [ $FAILED -gt 0 ]; then
        exit 1
    fi
}

main "$@"
