import { exec as execCallback } from "child_process";
import { promisify } from "util";
import { v4 as uuidv4 } from 'uuid';

const exec = promisify(execCallback);

// Basic interfaces for tmux objects
export interface TmuxSession {
  id: string;
  name: string;
  attached: boolean;
  windows: number;
}

export interface TmuxWindow {
  id: string;
  name: string;
  active: boolean;
  sessionId: string;
}

export interface TmuxPane {
  id: string;
  windowId: string;
  active: boolean;
  title: string;
}

interface CommandExecution {
  id: string;
  paneId: string;
  command: string;
  status: 'pending' | 'completed' | 'error';
  startTime: Date;
  result?: string;
  exitCode?: number;
  rawMode?: boolean;
}

export type ShellType = 'bash' | 'zsh' | 'fish';

/**
 * Execute a tmux command and return the result
 */
export async function executeTmux(tmuxCommand: string): Promise<string> {
  try {
    const { stdout } = await exec(`tmux ${tmuxCommand}`);
    return stdout.trim();
  } catch (error: any) {
    throw new Error(`Failed to execute tmux command: ${error.message}`);
  }
}

/**
 * Check if tmux server is running
 */
export async function isTmuxRunning(): Promise<boolean> {
  try {
    await executeTmux("list-sessions -F '#{session_name}'");
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * List all tmux sessions
 */
export async function listSessions(): Promise<TmuxSession[]> {
  const format = "#{session_id}:#{session_name}:#{?session_attached,1,0}:#{session_windows}";
  const output = await executeTmux(`list-sessions -F '${format}'`);

  if (!output) return [];

  return output.split('\n').map(line => {
    const [id, name, attached, windows] = line.split(':');
    return {
      id,
      name,
      attached: attached === '1',
      windows: parseInt(windows, 10)
    };
  });
}

/**
 * Find a session by name
 */
export async function findSessionByName(name: string): Promise<TmuxSession | null> {
  try {
    const sessions = await listSessions();
    return sessions.find(session => session.name === name) || null;
  } catch (error) {
    return null;
  }
}

/**
 * List windows in a session
 */
export async function listWindows(sessionId: string): Promise<TmuxWindow[]> {
  const format = "#{window_id}:#{window_name}:#{?window_active,1,0}";
  const output = await executeTmux(`list-windows -t '${sessionId}' -F '${format}'`);

  if (!output) return [];

  return output.split('\n').map(line => {
    const [id, name, active] = line.split(':');
    return {
      id,
      name,
      active: active === '1',
      sessionId
    };
  });
}

/**
 * List panes in a window
 */
export async function listPanes(windowId: string): Promise<TmuxPane[]> {
  const format = "#{pane_id}:#{pane_title}:#{?pane_active,1,0}";
  const output = await executeTmux(`list-panes -t '${windowId}' -F '${format}'`);

  if (!output) return [];

  return output.split('\n').map(line => {
    const [id, title, active] = line.split(':');
    return {
      id,
      windowId,
      title: title,
      active: active === '1'
    };
  });
}

/**
 * Capture content from a specific pane, by default the latest 200 lines.
 */
export async function capturePaneContent(paneId: string, lines: number = 200, includeColors: boolean = false): Promise<string> {
  const colorFlag = includeColors ? '-e' : '';
  return executeTmux(`capture-pane -p ${colorFlag} -t '${paneId}' -S -${lines} -E -`);
}

/**
 * Create a new tmux session
 */
export async function createSession(name: string): Promise<TmuxSession | null> {
  await executeTmux(`new-session -d -s "${name}"`);
  return findSessionByName(name);
}

/**
 * Create a new window in a session
 */
export async function createWindow(sessionId: string, name: string): Promise<TmuxWindow | null> {
  const output = await executeTmux(`new-window -t '${sessionId}' -n '${name}'`);
  const windows = await listWindows(sessionId);
  return windows.find(window => window.name === name) || null;
}

/**
 * Kill a tmux session by ID
 */
export async function killSession(sessionId: string): Promise<void> {
  await executeTmux(`kill-session -t '${sessionId}'`);
}

/**
 * Kill a tmux window by ID
 */
export async function killWindow(windowId: string): Promise<void> {
  await executeTmux(`kill-window -t '${windowId}'`);
}

/**
 * Kill a tmux pane by ID
 */
export async function killPane(paneId: string): Promise<void> {
  await executeTmux(`kill-pane -t '${paneId}'`);
}

/**
 * Split a tmux pane horizontally or vertically
 */
export async function splitPane(
  targetPaneId: string,
  direction: 'horizontal' | 'vertical' = 'vertical',
  size?: number
): Promise<TmuxPane | null> {
  // Build the split-window command
  let splitCommand = 'split-window';

  // Add direction flag (-h for horizontal, -v for vertical)
  if (direction === 'horizontal') {
    splitCommand += ' -h';
  } else {
    splitCommand += ' -v';
  }

  // Add target pane
  splitCommand += ` -t '${targetPaneId}'`;

  // Add size if specified (as percentage)
  if (size !== undefined && size > 0 && size < 100) {
    splitCommand += ` -p ${size}`;
  }

  // Execute the split command
  await executeTmux(splitCommand);

  // Get the window ID from the target pane to list all panes
  const windowInfo = await executeTmux(`display-message -p -t '${targetPaneId}' '#{window_id}'`);

  // List all panes in the window to find the newly created one
  const panes = await listPanes(windowInfo);

  // The newest pane is typically the last one in the list
  return panes.length > 0 ? panes[panes.length - 1] : null;
}

// Map to track ongoing command executions
const activeCommands = new Map<string, CommandExecution>();

// Cache for detected shell types per pane
const paneShellCache = new Map<string, ShellType>();

// Cache for panes that have been initialized with HISTCONTROL
const initializedPanes = new Set<string>();

const startMarkerText = 'TMUX_MCP_START';
const endMarkerPrefix = "TMUX_MCP_DONE_";
const initMarker = 'TMUX_MCP_INIT_DONE';

// Detect shell type for a specific pane
async function detectPaneShell(paneId: string): Promise<ShellType> {
  // Check cache first
  const cached = paneShellCache.get(paneId);
  if (cached) return cached;

  try {
    // Get the current command/process running in the pane
    const output = await executeTmux(`display-message -p -t '${paneId}' '#{pane_current_command}'`);
    const cmd = output.toLowerCase().trim();

    let shellType: ShellType = 'bash'; // default

    if (cmd === 'fish' || cmd.endsWith('/fish')) {
      shellType = 'fish';
    } else if (cmd === 'zsh' || cmd.endsWith('/zsh')) {
      shellType = 'zsh';
    } else if (cmd === 'bash' || cmd.endsWith('/bash')) {
      shellType = 'bash';
    }
    // For ssh or other commands, default to bash (most common on servers)

    paneShellCache.set(paneId, shellType);
    return shellType;
  } catch {
    return 'bash'; // default fallback
  }
}

// Check if pane is running SSH
async function isSSHPane(paneId: string): Promise<boolean> {
  try {
    const output = await executeTmux(`display-message -p -t '${paneId}' '#{pane_current_command}'`);
    const cmd = output.toLowerCase().trim();
    return cmd === 'ssh';
  } catch {
    return false;
  }
}

// Detect remote shell type and initialize HISTCONTROL in a single command
// This ensures the detection command itself doesn't pollute history
async function detectAndInitializeRemoteShell(paneId: string): Promise<ShellType> {
  // Single command that:
  // 1. Sets HISTCONTROL (for bash) or HIST_IGNORE_SPACE (for zsh) 
  // 2. Outputs shell type for detection
  // Leading space + HISTCONTROL setting ensures minimal history pollution
  // For bash: HISTCONTROL takes effect immediately for subsequent commands
  // For zsh: setopt takes effect immediately
  // For fish: No equivalent, but fish is rare on servers
  const initAndDetectCmd = ` export HISTCONTROL=ignorespace 2>/dev/null; setopt HIST_IGNORE_SPACE 2>/dev/null; echo ${initMarker}_SHELL_$0`;
  await executeTmux(`send-keys -t '${paneId}' '${initAndDetectCmd}' Enter`);
  
  // Wait for the command to complete
  await new Promise(resolve => setTimeout(resolve, 300));
  
  // Capture pane content and look for the marker
  const content = await capturePaneContent(paneId, 50);
  
  // Parse the shell type from output
  const match = content.match(new RegExp(`${initMarker}_SHELL_(-?\\w+)`));
  let shellType: ShellType = 'bash'; // default
  
  if (match) {
    const shell = match[1].toLowerCase().replace(/^-/, ''); // Remove leading dash (login shell)
    if (shell === 'fish' || shell.endsWith('/fish')) {
      shellType = 'fish';
    } else if (shell === 'zsh' || shell.endsWith('/zsh')) {
      shellType = 'zsh';
    }
  }
  
  // Mark as initialized (HISTCONTROL/HIST_IGNORE_SPACE already set in the combined command)
  initializedPanes.add(paneId);
  paneShellCache.set(paneId, shellType);
  
  return shellType;
}

// Initialize pane with proper HISTCONTROL setting
// Works for both local and SSH panes
async function initializePane(paneId: string, shellType: ShellType): Promise<void> {
  // Set up history control based on shell type
  // All commands start with space to prevent history recording (if HISTCONTROL is set)
  if (shellType === 'bash') {
    // For bash, export HISTCONTROL to ignore commands starting with space
    const initCmd = ` export HISTCONTROL="\${HISTCONTROL:+\$HISTCONTROL:}ignorespace"; echo ${initMarker}`;
    await executeTmux(`send-keys -t '${paneId}' '${initCmd}' Enter`);
    await new Promise(resolve => setTimeout(resolve, 200));
  } else if (shellType === 'zsh') {
    // For zsh, set HIST_IGNORE_SPACE option
    const initCmd = ` setopt HIST_IGNORE_SPACE 2>/dev/null; echo ${initMarker}`;
    await executeTmux(`send-keys -t '${paneId}' '${initCmd}' Enter`);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  // For fish, history is controlled by fish_history variable
  // Leading space doesn't work by default, but we handle fish differently in command execution
  
  // Mark this pane as initialized
  initializedPanes.add(paneId);
}

// Initialize SSH pane - detects remote shell and sets up history control in one command
async function initializeSSHPane(paneId: string): Promise<ShellType> {
  // Combined detection and initialization (no separate initializePane call needed)
  return await detectAndInitializeRemoteShell(paneId);
}

// Get end marker text based on shell type
function getEndMarkerForShell(shellType: ShellType): string {
  return shellType === 'fish'
    ? `${endMarkerPrefix}$status`
    : `${endMarkerPrefix}$?`;
}

// Build command for fish shell (no HISTCONTROL, uses fish-specific approach)
function buildFishCommand(command: string): string {
  // Fish uses $status instead of $?
  // Must NOT escape $status so fish expands it to the actual exit code
  return `echo "${startMarkerText}"; ${command}; set __exit $status; echo "${endMarkerPrefix}$__exit"`;
}

// Build command for bash/zsh (with HISTCONTROL prefix for safety)
function buildBashZshCommand(command: string, shellType: ShellType, isInitialized: boolean): string {
  const endMarker = getEndMarkerForShell(shellType);
  
  if (isInitialized) {
    // Pane is initialized, HISTCONTROL/HIST_IGNORE_SPACE is set
    // Leading space is enough to prevent history recording
    return ` echo "${startMarkerText}"; ${command}; echo "${endMarker}"`;
  } else {
    // Pane not initialized yet, include inline HISTCONTROL setting
    if (shellType === 'zsh') {
      return ` setopt HIST_IGNORE_SPACE 2>/dev/null; echo "${startMarkerText}"; ${command}; echo "${endMarker}"`;
    } else {
      // bash
      return ` HISTCONTROL=ignorespace; echo "${startMarkerText}"; ${command}; echo "${endMarker}"`;
    }
  }
}

// Execute a command in a tmux pane and track its execution
export async function executeCommand(paneId: string, command: string, rawMode?: boolean, noEnter?: boolean): Promise<string> {
  // Generate unique ID for this command execution
  const commandId = uuidv4();

  let fullCommand: string;
  
  if (rawMode || noEnter) {
    // Raw mode or noEnter - use command as-is
    fullCommand = command;
  } else {
    // Normal mode - use shell-aware command building with history pollution prevention
    // Check if this is an SSH pane
    const isSSH = await isSSHPane(paneId);
    
    let shellType: ShellType;
    let isInitialized = initializedPanes.has(paneId);
    
    if (isSSH && !isInitialized) {
      // Initialize SSH pane (detects remote shell and sets up HISTCONTROL)
      shellType = await initializeSSHPane(paneId);
      isInitialized = true;
    } else if (!isSSH && !isInitialized) {
      // Local pane - detect shell and initialize if needed
      shellType = await detectPaneShell(paneId);
      
      // For local non-fish shells, initialize HISTCONTROL
      if (shellType !== 'fish') {
        await initializePane(paneId, shellType);
        isInitialized = true;
      }
    } else {
      // Use cached shell type
      shellType = paneShellCache.get(paneId) || await detectPaneShell(paneId);
    }

    // Build the full command based on shell type
    if (shellType === 'fish') {
      // Fish shell - no HISTCONTROL support
      fullCommand = buildFishCommand(command);
    } else {
      // Bash or Zsh
      fullCommand = buildBashZshCommand(command, shellType, isInitialized);
    }
  }

  // Store command in tracking map
  activeCommands.set(commandId, {
    id: commandId,
    paneId,
    command,
    status: 'pending',
    startTime: new Date(),
    rawMode: rawMode || noEnter
  });

  // Send the command to the tmux pane
  if (noEnter) {
    // Check if this is a special key (e.g., Up, Down, Left, Right, Escape, Tab, etc.)
    // Special keys in tmux are typically capitalized or have special names
    const specialKeys = ['Up', 'Down', 'Left', 'Right', 'Escape', 'Tab', 'Enter', 'Space',
      'BSpace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
      'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'];

    if (specialKeys.includes(fullCommand)) {
      // Send special key as-is
      await executeTmux(`send-keys -t '${paneId}' ${fullCommand}`);
    } else {
      // For regular text, send each character individually to ensure proper processing
      // This handles both single characters (like 'q', 'f') and strings (like 'beam')
      for (const char of fullCommand) {
        await executeTmux(`send-keys -t '${paneId}' '${char.replace(/'/g, "'\\''")}'`);
      }
    }
  } else {
    await executeTmux(`send-keys -t '${paneId}' '${fullCommand.replace(/'/g, "'\\''")}' Enter`);
  }

  return commandId;
}

export async function checkCommandStatus(commandId: string): Promise<CommandExecution | null> {
  const command = activeCommands.get(commandId);
  if (!command) return null;

  if (command.status !== 'pending') return command;

  const content = await capturePaneContent(command.paneId, 1000);

  if (command.rawMode) {
    command.result = 'Status tracking unavailable for rawMode commands. Use capture-pane to monitor interactive apps instead.';
    return command;
  }

  // Find the last occurrence of the markers
  const startIndex = content.lastIndexOf(startMarkerText);
  const endIndex = content.lastIndexOf(endMarkerPrefix);

  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    command.result = "Command output could not be captured properly";
    return command;
  }

  // Extract exit code from the end marker line
  const endLine = content.substring(endIndex).split('\n')[0];
  const endMarkerRegex = new RegExp(`${endMarkerPrefix}(\\d+)`);
  const exitCodeMatch = endLine.match(endMarkerRegex);

  if (exitCodeMatch) {
    const exitCode = parseInt(exitCodeMatch[1], 10);

    command.status = exitCode === 0 ? 'completed' : 'error';
    command.exitCode = exitCode;

    // Extract output between the start and end markers
    const outputStart = startIndex + startMarkerText.length;
    const outputContent = content.substring(outputStart, endIndex).trim();

    command.result = outputContent.substring(outputContent.indexOf('\n') + 1).trim();

    // Update in map
    activeCommands.set(commandId, command);
  }

  return command;
}

// Get command by ID
export function getCommand(commandId: string): CommandExecution | null {
  return activeCommands.get(commandId) || null;
}

// Get all active command IDs
export function getActiveCommandIds(): string[] {
  return Array.from(activeCommands.keys());
}

// Clean up completed commands older than a certain time
export function cleanupOldCommands(maxAgeMinutes: number = 60): void {
  const now = new Date();

  for (const [id, command] of activeCommands.entries()) {
    const ageMinutes = (now.getTime() - command.startTime.getTime()) / (1000 * 60);

    if (command.status !== 'pending' && ageMinutes > maxAgeMinutes) {
      activeCommands.delete(id);
    }
  }
}
