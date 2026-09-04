import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

export function defaultRuntimeHome({
  env = process.env,
  home = homedir(),
  platform = process.platform
} = {}) {
  const pathApi = platform === 'win32' ? win32 : posix;

  if (env.AGENT_CONTEXT_BROKER_HOME?.trim()) {
    return pathApi.resolve(env.AGENT_CONTEXT_BROKER_HOME);
  }

  if (platform === 'win32') {
    return pathApi.join(
      env.LOCALAPPDATA?.trim() || pathApi.join(home, 'AppData', 'Local'),
      'AgentContextBroker'
    );
  }

  if (platform === 'linux') {
    return pathApi.join(
      env.XDG_STATE_HOME?.trim() || pathApi.join(home, '.local', 'state'),
      'agent-context-broker'
    );
  }

  throw new Error(`Unsupported platform without AGENT_CONTEXT_BROKER_HOME: ${platform}`);
}
