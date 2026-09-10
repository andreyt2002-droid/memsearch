import test from 'node:test'
import assert from 'node:assert/strict'

import { withIsolatedEnv } from './env.js'

/** Restore one process environment value after this test's setup. */
function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

test('withIsolatedEnv restores set and masked variables after a rejected body', async () => {
  const prefix = `MEMSEARCH_DSH_TEST_${process.pid}`
  const existing = `${prefix}_EXISTING`
  const absent = `${prefix}_ABSENT`
  const masked = `${prefix}_MASKED`
  const beforeExisting = process.env[existing]
  const beforeAbsent = process.env[absent]
  const beforeMasked = process.env[masked]
  process.env[existing] = 'outside'
  delete process.env[absent]
  process.env[masked] = 'outside'

  try {
    await assert.rejects(
      withIsolatedEnv({ [existing]: 'inside', [absent]: 'temporary', [masked]: null }, async () => {
        assert.equal(process.env[existing], 'inside')
        assert.equal(process.env[absent], 'temporary')
        assert.equal(process.env[masked], undefined)
        throw new Error('expected test failure')
      }),
      /expected test failure/,
    )
    assert.equal(process.env[existing], 'outside')
    assert.equal(process.env[absent], undefined)
    assert.equal(process.env[masked], 'outside')
  } finally {
    restoreEnv(existing, beforeExisting)
    restoreEnv(absent, beforeAbsent)
    restoreEnv(masked, beforeMasked)
  }
})

test('withIsolatedEnv rejects every overlapping body before mutation', async () => {
  const key = `MEMSEARCH_DSH_TEST_${process.pid}_OVERLAP`
  const otherKey = `${key}_DISJOINT`
  const before = process.env[key]
  const beforeOther = process.env[otherKey]
  process.env[key] = 'outside'
  process.env[otherKey] = 'outside-other'
  let release
  const gate = new Promise((resolve) => { release = resolve })

  try {
    const first = withIsolatedEnv({ [key]: 'first' }, async () => {
      assert.equal(process.env[key], 'first')
      await gate
    })
    await assert.rejects(
      withIsolatedEnv({ [otherKey]: 'second' }, () => {}),
      /withIsolatedEnv overlap/,
    )
    assert.equal(process.env[key], 'first', 'rejected overlap did not mutate the active value')
    assert.equal(process.env[otherKey], 'outside-other', 'disjoint override was not applied')
    release()
    await first
    assert.equal(process.env[key], 'outside')
  } finally {
    release?.()
    restoreEnv(key, before)
    restoreEnv(otherKey, beforeOther)
  }
})
