/**
 * State Machine Unit Tests
 *
 * TC-U01: State transitions
 * TC-U03: State priority
 */

import { describe, it, expect } from 'vitest'
import {
  transition,
  highestPriority,
  settleAfterTimeout,
  STATE_PRIORITY,
} from './state-machine.js'
import type { AndonStatus } from './types.js'

describe('StateMachine', () => {
  describe('transition', () => {
    it('IDLE → THINKING on message.updated (assistant, not completed)', () => {
      const result = transition('IDLE', {
        type: 'message.updated',
        role: 'assistant',
        completed: false,
      })
      expect(result).toBe('THINKING')
    })

    it('IDLE → THINKING on session.status (busy)', () => {
      const result = transition('IDLE', {
        type: 'session.status',
        role: 'busy',
      })
      expect(result).toBe('THINKING')
    })

    it('IDLE → EXECUTING on tool.call.started', () => {
      const result = transition('IDLE', {
        type: 'tool.call.started',
      })
      expect(result).toBe('EXECUTING')
    })

    it('THINKING → EXECUTING on tool.call.started', () => {
      const result = transition('THINKING', {
        type: 'tool.call.started',
      })
      expect(result).toBe('EXECUTING')
    })

    it('THINKING → IDLE on message.updated (completed)', () => {
      const result = transition('THINKING', {
        type: 'message.updated',
        role: 'assistant',
        completed: true,
      })
      expect(result).toBe('IDLE')
    })

    it('THINKING → IDLE on session.idle', () => {
      const result = transition('THINKING', {
        type: 'session.idle',
      })
      expect(result).toBe('IDLE')
    })

    it('EXECUTING → THINKING on tool.call.completed (no running tools)', () => {
      const result = transition('EXECUTING', {
        type: 'tool.call.completed',
        runningTools: 0,
      })
      expect(result).toBe('THINKING')
    })

    it('EXECUTING stays EXECUTING if tools still running', () => {
      const result = transition('EXECUTING', {
        type: 'tool.call.completed',
        runningTools: 2,
      })
      expect(result).toBe('EXECUTING')  // No matching transition
    })

    it('any state → ERROR on session.error', () => {
      const states: AndonStatus[] = ['IDLE', 'THINKING', 'EXECUTING', 'COMPLETE']
      for (const state of states) {
        const result = transition(state, { type: 'session.error' })
        expect(result).toBe('ERROR')
      }
    })

    it('ERROR → IDLE on session.idle', () => {
      const result = transition('ERROR', {
        type: 'session.idle',
      })
      expect(result).toBe('IDLE')
    })

    it('any state → COMPLETE on session.complete', () => {
      const states: AndonStatus[] = ['IDLE', 'THINKING', 'EXECUTING', 'ERROR']
      for (const state of states) {
        const result = transition(state, { type: 'session.complete' })
        expect(result).toBe('COMPLETE')
      }
    })

    it('stays in current state for unknown event', () => {
      const result = transition('IDLE', {
        type: 'unknown.event',
      })
      expect(result).toBe('IDLE')
    })
  })

  describe('highestPriority', () => {
    it('ERROR has highest priority', () => {
      const result = highestPriority(['IDLE', 'ERROR', 'THINKING'])
      expect(result).toBe('ERROR')
    })

    it('EXECUTING > THINKING', () => {
      const result = highestPriority(['THINKING', 'EXECUTING', 'IDLE'])
      expect(result).toBe('EXECUTING')
    })

    it('THINKING > IDLE', () => {
      const result = highestPriority(['IDLE', 'THINKING'])
      expect(result).toBe('THINKING')
    })

    it('returns IDLE for empty array', () => {
      const result = highestPriority([])
      expect(result).toBe('IDLE')
    })

    it('single element returns itself', () => {
      expect(highestPriority(['ERROR'])).toBe('ERROR')
      expect(highestPriority(['IDLE'])).toBe('IDLE')
    })
  })

  describe('settleAfterTimeout', () => {
    it('THINKING → IDLE after timeout', () => {
      const result = settleAfterTimeout('THINKING')
      expect(result).toBe('IDLE')
    })

    it('EXECUTING → IDLE after timeout', () => {
      const result = settleAfterTimeout('EXECUTING')
      expect(result).toBe('IDLE')
    })

    it('ERROR stays ERROR', () => {
      const result = settleAfterTimeout('ERROR')
      expect(result).toBe('ERROR')
    })

    it('IDLE stays IDLE', () => {
      const result = settleAfterTimeout('IDLE')
      expect(result).toBe('IDLE')
    })

    it('COMPLETE stays COMPLETE', () => {
      const result = settleAfterTimeout('COMPLETE')
      expect(result).toBe('COMPLETE')
    })
  })

  describe('STATE_PRIORITY', () => {
    it('priority order is correct', () => {
      expect(STATE_PRIORITY.ERROR).toBeGreaterThan(STATE_PRIORITY.EXECUTING)
      expect(STATE_PRIORITY.EXECUTING).toBeGreaterThan(STATE_PRIORITY.THINKING)
      expect(STATE_PRIORITY.THINKING).toBeGreaterThan(STATE_PRIORITY.IDLE)
      expect(STATE_PRIORITY.IDLE).toBeGreaterThan(STATE_PRIORITY.COMPLETE)
      expect(STATE_PRIORITY.COMPLETE).toBeGreaterThan(STATE_PRIORITY.DISCONNECTED)
    })
  })
})
