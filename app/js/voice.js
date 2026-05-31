/**
 * Voice Input Module (Phase 2)
 *
 * Handles microphone capture and audio streaming to PC.
 * Uses Web Audio API + MediaRecorder.
 *
 * TODO: Implement in Phase 2
 * - getUserMedia for mic access
 * - MediaRecorder for encoding
 * - WebSocket binary frames for streaming
 * - VAD (Voice Activity Detection)
 * - Volume visualization
 */

export class VoiceInput {
  /** @type {MediaStream|null} */
  #stream = null
  /** @type {MediaRecorder|null} */
  #recorder = null
  /** @type {boolean} */
  #recording = false

  get isRecording() {
    return this.#recording
  }

  /**
   * Request microphone permission and start recording
   * @param {Function} onData - Callback for audio data chunks
   * @returns {Promise<void>}
   */
  async start(onData) {
    if (this.#recording) return

    try {
      this.#stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
        },
      })

      this.#recorder = new MediaRecorder(this.#stream, {
        mimeType: this.#getSupportedMimeType(),
      })

      this.#recorder.ondataavailable = (event) => {
        if (event.data.size > 0 && onData) {
          onData(event.data)
        }
      }

      this.#recorder.start(250) // Send chunks every 250ms
      this.#recording = true
    } catch (err) {
      console.error('[voice] Failed to start recording:', err)
      this.stop()
      throw err
    }
  }

  /** Stop recording and release microphone */
  stop() {
    if (this.#recorder && this.#recorder.state !== 'inactive') {
      this.#recorder.stop()
    }
    if (this.#stream) {
      for (const track of this.#stream.getTracks()) {
        track.stop()
      }
      this.#stream = null
    }
    this.#recorder = null
    this.#recording = false
  }

  /**
   * Find a supported MIME type for MediaRecorder
   * @returns {string}
   */
  #getSupportedMimeType() {
    const types = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
    ]
    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) return type
    }
    return '' // Let browser decide
  }
}
