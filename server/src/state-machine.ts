/**
 * Andon State Machine — Formal state transition definitions
 *
 * A-SPICE: SWE.3 Detailed Design
 */

import type { AndonStatus } from './types.js'

// ── State Priority ───────────────────────────────────────

export const STATE_PRIORITY: Record<AndonStatus, number> = {
  ERROR: 5,
  EXECUTING: 4,
  THINKING: 3,
  IDLE: 2,
  COMPLETE: 1,
  DISCONNECTED: 0,
}

/**
 * Return the highest priority status from a list
 */
export function highestPriority(statuses: AndonStatus[]): AndonStatus {
  if (statuses.length === 0) return 'IDLE'
  return statuses.reduce((a, b) => 
    STATE_PRIORITY[b] > STATE_PRIORITY[a] ? b : a
  , 'IDLE')
}

// ── State Transitions ────────────────────────────────────

export interface StateTransitionEvent {
  type: string
  role?: string
  completed?: boolean
  runningTools?: number
}

export interface StateTransition {
  from: AndonStatus | '*'
  to: AndonStatus
  event: string
  guard?: (e: StateTransitionEvent) => boolean
}

export const TRANSITIONS: StateTransition[] = [
  // IDLE → THINKING
  { from: 'IDLE', to: 'THINKING', event: 'message.updated', guard: e => e.role === 'assistant' && !e.completed },
  { from: 'IDLE', to: 'THINKING', event: 'session.status', guard: e => e.role === 'busy' },
  
  // IDLE → EXECUTING
  { from: 'IDLE', to: 'EXECUTING', event: 'tool.call.started' },
  
  // THINKING → EXECUTING
  { from: 'THINKING', to: 'EXECUTING', event: 'tool.call.started' },
  
  // THINKING → IDLE
  { from: 'THINKING', to: 'IDLE', event: 'message.updated', guard: e => e.role === 'assistant' && e.completed === true },
  { from: 'THINKING', to: 'IDLE', event: 'session.idle' },
  { from: 'THINKING', to: 'IDLE', event: 'session.status', guard: e => e.role === 'idle' },
  
  // EXECUTING → THINKING
  { from: 'EXECUTING', to: 'THINKING', event: 'tool.call.completed', guard: e => (e.runningTools ?? 0) === 0 },
  { from: 'EXECUTING', to: 'THINKING', event: 'tool.call.failed', guard: e => (e.runningTools ?? 0) === 0 },
  
  // * → ERROR
  { from: '*', to: 'ERROR', event: 'session.error' },
  
  // ERROR → IDLE
  { from: 'ERROR', to: 'IDLE', event: 'session.idle' },
  
  // * → COMPLETE
  { from: '*', to: 'COMPLETE', event: 'session.complete' },
  
  // COMPLETE → IDLE
  { from: 'COMPLETE', to: 'IDLE', event: 'session.reset' },
]

/**
 * Compute next state given current state and event
 */
export function transition(
  current: AndonStatus,
  event: StateTransitionEvent
): AndonStatus {
  const eventType = event.type
  
  // Find matching transition
  for (const t of TRANSITIONS) {
    if (t.event !== eventType) continue
    if (t.from !== '*' && t.from !== current) continue
    if (t.guard && !t.guard(event)) continue
    return t.to
  }
  
  // No transition matches, stay in current state
  return current
}

/**
 * Settle status after inactivity timeout
 */
export function settleAfterTimeout(
  current: AndonStatus,
  activeStates: AndonStatus[] = ['THINKING', 'EXECUTING']
): AndonStatus {
  if (activeStates.includes(current)) {
    return 'IDLE'
  }
  return current
}
