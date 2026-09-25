type ShutdownReason = 'idle' | 'SIGINT' | 'SIGTERM' | 'startup-error';

type LifecycleOptions = {
  idleExitMs: number;
  hasPendingJobs: () => Promise<boolean>;
  drainWorkers: () => Promise<void>;
  stopQueue: () => Promise<void>;
  closeResources: () => Promise<void>;
  onDraining: (reason: ShutdownReason) => void;
  now?: () => number;
};

// No timers or database connections of its own. Both an idle exit and an
// operator's stop request follow the same drain-before-disconnect path.
export function createWorkerLifecycle(options: LifecycleOptions) {
  const now = options.now ?? (() => performance.now());
  let lastActivity = now();
  let generation = 0;
  let activeTasks = 0;
  let state: 'running' | 'draining' | 'stopped' = 'running';
  let shutdown: Promise<void> | undefined;
  let checking: Promise<void> | undefined;
  let resolveTasks: (() => void) | undefined;

  async function runTask<T>(work: () => Promise<T>, countsAsActivity = true): Promise<T> {
    // A fetch already in flight when offWork is called may still deliver a job.
    // Let that claimed job finish; pg-boss offWork(wait: true) also waits for its
    // acknowledgement and heartbeat cleanup, not just this callback.
    activeTasks += 1;
    generation += 1;
    if (countsAsActivity) lastActivity = now();
    try {
      return await work();
    } finally {
      activeTasks -= 1;
      generation += 1;
      if (countsAsActivity) lastActivity = now();
      if (activeTasks === 0) resolveTasks?.();
    }
  }

  function stop(reason: ShutdownReason): Promise<void> {
    if (shutdown) return shutdown;
    state = 'draining';
    // Defer the body so repeated signals share the published shutdown promise.
    shutdown = Promise.resolve().then(async () => {
      options.onDraining(reason);
      await options.drainWorkers();
      // Includes an already-running delete-pending sweep. Never close its pool
      // while it is updating a video after deleting an R2 object.
      if (activeTasks > 0) await new Promise<void>((resolve) => { resolveTasks = resolve; });
      try {
        await options.stopQueue();
      } finally {
        await options.closeResources();
        state = 'stopped';
      }
    });
    return shutdown;
  }

  function checkIdle(): Promise<void> {
    if (checking) return checking;
    checking = (async () => {
      if (state !== 'running' || options.idleExitMs === 0 || activeTasks > 0
        || now() - lastActivity < options.idleExitMs) return;
      const observedGeneration = generation;
      // A failed check is NOT proof that the queue is empty. Do not use cached
      // queue statistics: they can lag newly-created or delayed retry jobs.
      const pending = await options.hasPendingJobs();
      if (state !== 'running' || activeTasks > 0 || generation !== observedGeneration) return;
      if (pending) {
        lastActivity = now();
        return;
      }
      await stop('idle');
    })().finally(() => { checking = undefined; });
    return checking;
  }

  return { runTask, checkIdle, stop, isRunning: () => state === 'running' };
}

export function readIdleExitSeconds(value: string | undefined): number {
  // Keep existing long-running deployments compatible. The local batch
  // compose file explicitly opts into a 120-second idle exit.
  if (value === undefined) return 0;
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error('VIDEO_WORKER_IDLE_EXIT_SECONDS must be 0 or an integer from 30 to 86400.');
  const seconds = Number(value);
  if (seconds !== 0 && (seconds < 30 || seconds > 86_400)) {
    throw new Error('VIDEO_WORKER_IDLE_EXIT_SECONDS must be 0 or an integer from 30 to 86400.');
  }
  return seconds;
}

export const pendingTranscodeSql = `SELECT EXISTS (
  SELECT 1 FROM pgboss.job
  WHERE name = $1 AND state IN ('created', 'retry', 'active')
) AS pending`;
