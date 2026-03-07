# Tmux MCP Server

Model Context Protocol server that enables Claude Desktop to interact with and view tmux session content. This integration allows AI assistants to read from, control, and observe your terminal sessions.

## Features

- List and search tmux sessions
- View and navigate tmux windows and panes
- Capture and expose terminal content from any pane
- Execute commands in tmux panes and retrieve results (use it at your own risk ⚠️)
- Create new tmux sessions and windows
- Split panes horizontally or vertically with customizable sizes
- Kill tmux sessions, windows, and panes

Check out this short video to get excited!

</br>

[![youtube video](http://i.ytimg.com/vi/3W0pqRF1RS0/hqdefault.jpg)](https://www.youtube.com/watch?v=3W0pqRF1RS0)

## Prerequisites

- Node.js
- tmux installed and running

## Usage

### Configure Claude Desktop

Add this MCP server to your Claude Desktop configuration:

```json
"mcpServers": {
  "tmux": {
    "command": "npx",
    "args": ["-y", "tmux-mcp"]
  }
}
```

### MCP server options

You can optionally specify the command line shell you are using, if unspecified it defaults to `bash`

```json
"mcpServers": {
  "tmux": {
    "command": "npx",
    "args": ["-y", "tmux-mcp", "--shell-type=fish"]
  }
}
```

The MCP server needs to know the shell only when executing commands, to properly read its exit status.

## Available Resources

- `tmux://sessions` - List all tmux sessions
- `tmux://pane/{paneId}` - View content of a specific tmux pane
- `tmux://command/{commandId}/result` - Results from executed commands

## Available Tools

- `list-sessions` - List all active tmux sessions
- `find-session` - Find a tmux session by name
- `list-windows` - List windows in a tmux session
- `list-panes` - List panes in a tmux window
- `capture-pane` - Capture content from a tmux pane
- `create-session` - Create a new tmux session
- `create-window` - Create a new window in a tmux session
- `split-pane` - Split a tmux pane horizontally or vertically with optional size
- `kill-session` - Kill a tmux session by ID
- `kill-window` - Kill a tmux window by ID
- `kill-pane` - Kill a tmux pane by ID
- `execute-command` - Execute a command in a tmux pane
- `get-command-result` - Get the result of an executed command
- `capture-last-output` - Capture the output of a recent command using OSC 133 marks
- `capture-last-command` - Capture the command line of a recent command using OSC 133 marks
- `capture-last-command-with-output` - Capture both command and output using OSC 133 marks

### OSC 133 Shell Integration

The `capture-last-output`, `capture-last-command`, and `capture-last-command-with-output` tools use [OSC 133 semantic prompt marks](https://gitlab.freedesktop.org/Per_Bothner/specifications/blob/master/proposals/semantic-prompts.md) to precisely capture command output without guessing line counts or parsing prompt patterns.

**Requirements:** Your shell must emit OSC 133 escape sequences. Many modern terminals (Ghostty, iTerm2, WezTerm) enable this automatically. For manual setup:

- **Bash (4.4+):** Add to `.bashrc`:
  ```bash
  PS0=$'\033]133;C\007'
  PS1='\[\033]133;B\007\]$ '
  PROMPT_COMMAND='printf "\033]133;D;%s\007" "$?"; printf "\033]133;A\007"'
  ```
- **Zsh:** Add to `.zshrc`:
  ```zsh
  _osc133_preexec() { printf '\e]133;C\e\\' }
  _osc133_precmd() {
    printf '\e]133;D\e\\'
    PROMPT=$'%{\e]133;A\e\\\\%}'"$PROMPT"$'%{\e]133;B\e\\\\%}'
  }
  autoload -Uz add-zsh-hook
  add-zsh-hook preexec _osc133_preexec
  add-zsh-hook precmd _osc133_precmd
  ```
  > **Note:** If you use a prompt theme like [Starship](https://starship.rs/) that regenerates `$PROMPT` in `precmd`, the `_osc133_precmd` hook wraps the regenerated prompt with A/B marks each time — no extra configuration needed.
- **Fish:** Shell integration is built-in for supported terminals.

**Parameters** (all three tools):
- `paneId` (string, required) - Target pane ID (e.g. `%0`)
- `n` (number, optional, default: 1) - Which command to capture (1 = most recent, 2 = second most recent, etc.)

