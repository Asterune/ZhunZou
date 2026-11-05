import type { DeviceConnection, DeviceConnectionOptions } from './connection.js';
import { createDeviceConnection } from './connection.js';

export interface DeviceDaemonOptions extends DeviceConnectionOptions {
  signal?: AbortSignal;
}

/**
 * Start a reverse connection and keep it alive until the signal aborts.
 *
 * The CLI uses this; tests call `createDeviceConnection` directly so they can
 * stop the socket without touching process signals.
 */
export async function runDeviceDaemon(
  options: DeviceDaemonOptions,
): Promise<number> {
  const connection = createDeviceConnection(options);
  connection.start();

  await new Promise<void>((resolve) => {
    if (options.signal) {
      if (options.signal.aborted) {
        resolve();
        return;
      }
      options.signal.addEventListener('abort', () => resolve(), { once: true });
      return;
    }

    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });

  connection.stop();
  return 0;
}

export function startDeviceDaemon(
  options: DeviceConnectionOptions,
): DeviceConnection {
  const connection = createDeviceConnection(options);
  connection.start();
  return connection;
}
