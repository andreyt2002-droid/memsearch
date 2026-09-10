/**
 * Shared test helper: run a body with ambient environment variables masked.
 *
 * Every key in `overrides` is applied before the body runs and restored after
 * it settles (success or failure), including keys that were previously unset.
 * A `null` value masks the variable, so an ambient developer override (for
 * example a real `MEMSEARCH_CMD` from a linked profile) can never leak into
 * the test body and spawn a real CLI that holds temp dirs open or writes to a
 * production database. Fake CLIs are always passed through these explicit
 * overrides as JSON-argv values, never through PATH injection.
 */

const DEFAULT_ISOLATED_ENV = {
  DSH_CLI: null,
  MEMSEARCH_CMD: null,
  MEMSEARCH_DIR: null,
  MEMSEARCH_PYTHON: null,
}

let envBodyActive = false

/**
 * Apply `overrides` to an environment with all MemSearch/DSH command routing
 * masked, await `fn`, then restore every previous value. Because `process.env`
 * is process-global and subprocesses inherit all of it, every overlapping call
 * is rejected before mutation, even when the requested keys are disjoint.
 *
 * @param {Record<string, string | null>} overrides env vars to set, or `null` to mask.
 * @param {() => unknown} fn sync or async test body.
 * @returns {Promise<unknown>} whatever `fn` returns.
 */
export async function withIsolatedEnv(overrides, fn) {
  if (envBodyActive) throw new Error('withIsolatedEnv overlap')
  envBodyActive = true

  const effective = { ...DEFAULT_ISOLATED_ENV, ...overrides }
  const saved = {}
  try {
    for (const [key, value] of Object.entries(effective)) {
      saved[key] = process.env[key]
      if (value === null || value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    return await fn()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    envBodyActive = false
  }
}
