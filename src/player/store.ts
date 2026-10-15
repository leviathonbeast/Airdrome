// store.ts
import { defineStore } from 'pinia'
import { shuffle, shuffled, trackListEquals, formatArtists, sleep } from '@/shared/utils'
import { Track } from '@/shared/api'
import { AudioController, ReplayGainMode } from '@/player/audio'
import { useMainStore } from '@/shared/store'
import { throttle } from 'lodash-es'
import { useRadioStore } from './radio'

const isMobile = matchMedia('(pointer: coarse)').matches && navigator.maxTouchPoints > 0

// Remove obsolete localStorage keys
localStorage.removeItem('player.mute')
localStorage.removeItem('queue')
localStorage.removeItem('queueIndex')

// ── Module-level singletons ──────────────────────────────────────────────
const storedReplayGainMode = parseInt(localStorage.getItem('player.replayGainMode') ?? '0')
const mediaSession: MediaSession | undefined = navigator.mediaSession
const audio = new AudioController()
const mediaSessionProgressRate = 1

// ── Store ────────────────────────────────────────────────────────────────
export const usePlayerStore = defineStore('player', {
  state: () => ({
    /** Playback queue. */
    queue: [] as Track[],
    /** Current track index (-1 = none). */
    queueIndex: -1,
    /** Current track duration (s). */
    duration: 0.0,
    /** Current position (s). */
    currentTime: 0.0,
    replayGainMode: storedReplayGainMode as ReplayGainMode,
    repeat: localStorage.getItem('player.repeat') === 'true',
    shuffle: localStorage.getItem('player.shuffle') === 'true',
    /** Master volume (0–1). */
    volume: 1.0,
    isPlaying: false,
    /** Current track already scrobbled. */
    scrobbled: false,
    /** A track change is in progress. */
    inTransition: false,
    /** User explicitly paused (prevents auto-resume). */
    userPaused: true
  }),

  getters: {
    /** Current track, or null. */
    track(): Track | null {
      if (this.queue && this.queueIndex !== -1) {
        return this.queue[this.queueIndex]
      }
      return null
    },

    /** Next track (wraps around), or null. */
    nextTrack(): Track | null {
      if (this.queue && this.queue.length > 0) {
        const next = (this.queueIndex + 1) % this.queue.length
        return this.queue[next]
      }
      return null
    },

    /** Current track ID, or null. */
    trackId(): string | null {
      return this.track?.id ?? null
    },

    /** Position clamped to [0, duration]. */
    progress(): number {
      if (this.duration > 0) {
        return Math.min(this.currentTime, this.duration)
      }
      return 0
    },

    /** True if a track follows the current one. */
    hasNext(): boolean {
      return !!this.queue && (this.queueIndex < this.queue.length - 1)
    },

    /** True if a track precedes the current one. */
    hasPrevious(): boolean {
      return this.queueIndex > 0
    },
  },

  actions: {
    /** Play tracks in order from the first one. */
    async playNow(tracks: Track[]) {
      this.setShuffle(false)
      await this.playTrackList(tracks, 0)
    },

    /** Play tracks shuffled. */
    async shuffleNow(tracks: Track[]) {
      this.setShuffle(true)
      await this.playTrackList(tracks)
    },

    /** Jump to a queue index. */
    async playTrackListIndex(index: number) {
      this.inTransition = true
      this.setQueueIndex(index)
      const track = this.track
      const nextTrack = this.nextTrack
      if (track)
        await audio.loadTrack({
          url: track.url,
          replayGain: track.replayGain,
          nextUrl: nextTrack?.url,
          fade: true
        })
      this.inTransition = false
    },

    /** Set the queue (if changed) and play from index; random start when shuffled. */
    async playTrackList(tracks: Track[], index?: number) {
      this.inTransition = true
      if (index == null) {
        index = this.shuffle ? Math.floor(Math.random() * tracks.length) : 0
      }
      if (this.shuffle) {
        tracks = [...tracks]
        shuffle(tracks, index) // moves chosen track to position 0
        index = 0
      }
      if (!trackListEquals(this.queue || [], tracks)) {
        this.setQueue(tracks)
      }
      this.setQueueIndex(index)
      const track = this.track
      const nextTrack = this.nextTrack
      if (track)
        await audio.loadTrack({
          url: track.url,
          replayGain: track.replayGain,
          nextUrl: nextTrack?.url,
          fade: true
        })
      this.inTransition = false
    },

    /** Resume playback. */
    async play() {
      await audio.resume()
      await audio.play()
    },

    /** Pause playback. */
    async pause() {
      this.userPaused = true
      await audio.pause()
    },

    /** Stop playback and reset the media session. */
    async stop() {
      this.userPaused = true
      await audio.stop()
      this.setMediaSessionPosition(0, 0)
      this.setMediaSessionState('none')
    },

    /** Toggle play/pause. */
    async playPause() {
      if (this.isPlaying) {
        return this.pause()
      } else {
        return this.play()
      }
    },

    /** Go to the next track, or handle queue end. */
    async next(fade = true) {
      if (this.hasNext || this.repeat) {
        this.inTransition = true
        this.setQueueIndex(this.queueIndex + 1)

        const track = this.track
        const nextTrack = this.nextTrack
        if (track)
          await audio.loadTrack({
            url: track.url,
            replayGain: track.replayGain,
            nextUrl: nextTrack?.url,
            fade
          })
        this.inTransition = false
        await sleep(200)
        this.setMediaSessionPosition()
        this.setMediaSessionState()
      } else {
        await this.processQueueEnd()
      }
    },

    /** Restart the track if played > 3s, otherwise go to the previous one. */
    async back() {
      if (this.currentTime > 3) {
        await this.seek(0)
      } else {
        this.inTransition = true
        this.setQueueIndex(this.queueIndex - 1)
        const track = this.track
        const nextTrack = this.nextTrack
        if (track)
          await audio.loadTrack({
            url: track.url,
            replayGain: track.replayGain,
            nextUrl: nextTrack?.url,
            fade: true
          })
        this.inTransition = false
        await sleep(200)
        this.setMediaSessionPosition()
        this.setMediaSessionState()
      }
    },

    /** Seek to a position (s). */
    async seek(position: number) {
      await audio.seek(position)
      await sleep(200)
      this.setMediaSessionPosition()
      this.setMediaSessionState()
    },

    /** Restore the saved queue from the server (paused). */
    async loadQueue() {
      const { tracks, currentTrack, currentTrackPosition } = await this.api.getPlayQueue()
      if (!tracks) {
        return
      }
      this.setQueue(tracks)
      this.setQueueIndex(currentTrack)
      const track = this.track
      const nextTrack = this.nextTrack
      if (!track) return
      await audio.loadTrack({
        url: track.url,
        replayGain: track.replayGain,
        nextUrl: nextTrack?.url,
        fade: true,
        paused: true
      })
      await this.seek(currentTrackPosition)
    },

    /** Save the queue and position to the server (when online). */
    async saveQueue() {
      const queue = this.queue
      const track = this.track
      const currentTime = this.currentTime
      if (navigator.onLine && queue && track) {
        this.api.savePlayQueue(queue, track, Math.trunc(currentTime))
          .catch(err => { console.info('[queue] save aborted:', err) })
      }
    },

    /** Go back to the first track, paused. */
    async resetQueue() {
      if (!this.queue.length || !this.track?.url) {
        this.setQueueIndex(-1)
        return
      }
      this.setQueueIndex(0)
      const track = this.track
      const nextTrack = this.nextTrack
      if (!track) return
      await audio.loadTrack({
        url: track.url,
        replayGain: track.replayGain,
        nextUrl: nextTrack?.url,
        fade: true,
        paused: true
      })
    },

    /** Keep only the current track; if alone, empty the queue and stop. */
    async clearQueue() {
      if (!this.queue.length) {
        return
      }
      if (this.queue.length > 1) {
        this.setQueue([this.queue[this.queueIndex]])
        this.setQueueIndex(0)
      } else {
        this.setQueue([])
        this.setQueueIndex(-1)
        await this.stop()
      }
      this.saveQueue()
    },

    /** Update the lock-screen position state. */
    async setMediaSessionPosition(_duration?: number, _position?: number) {
      _duration ??= this.duration
      _position ??= this.currentTime
      if (navigator.mediaSession) {
        navigator.mediaSession.setPositionState({
          duration: _duration,
          playbackRate: mediaSessionProgressRate,
          position: _position
        })
      }
    },

    /** Update the lock-screen playback state. */
    setMediaSessionState(_state?: MediaSessionPlaybackState) {
      if (!_state) {
        _state = this.isPlaying ? 'playing' : 'paused'
      }
      if (navigator.mediaSession) {
        mediaSession!.playbackState = _state
      }
    },

    /** Append tracks to the queue (shuffled if shuffle is on). */
    addToQueue(tracks: Track[]) {
      const lastTrack = this.queue && this.queue.length > 0 ? this.queue[this.queue.length - 1] : null
      if (tracks.length === 1 && tracks[0].id === lastTrack?.id) {
        return
      }
      this.queue?.push(...this.shuffle ? shuffled(tracks) : tracks)
      this.saveQueue()
    },

    /** Insert tracks right after the current one. */
    setNextInQueue(tracks: Track[]) {
      if (tracks.length === 1 && tracks[0].id === this.nextTrack?.id) {
        return
      }
      this.queue?.splice(this.queueIndex + 1, 0, ...(this.shuffle ? shuffled(tracks) : tracks))
      this.saveQueue()
    },

    /** Remove a track; if it was playing, move to its replacement or stop. */
    async removeFromQueue(index: number) {
      const wasCurrent = index === this.queueIndex

      this.queue = this.queue.filter((_, i) => i !== index)

      if (index < this.queueIndex) {
        this.queueIndex--
      }

      if (!wasCurrent) {
        this.saveQueue()
        return
      }

      if (this.queue.length === 0) {
        this.queueIndex = -1
        await this.stop()
        this.saveQueue()
        return
      }

      this.inTransition = true
      this.setQueueIndex(Math.min(this.queueIndex, this.queue.length - 1))
      const track = this.track
      const nextTrack = this.nextTrack
      if (track && this.isPlaying)
        await audio.loadTrack({
          url: track.url,
          replayGain: track.replayGain,
          nextUrl: nextTrack?.url,
          fade: true
        })
      this.inTransition = false
      this.saveQueue()
    },

    /** Reshuffle the queue, keeping the current track first. */
    shuffleQueue() {
      if (this.queue && this.queue.length > 0) {
        this.queue = shuffled(this.queue, this.queueIndex)
        this.queueIndex = 0
      }
    },

    /** Cycle ReplayGain mode and persist it. */
    toggleReplayGain() {
      const mode = (this.replayGainMode + 1) % ReplayGainMode._Length
      audio.setReplayGainMode(mode)
      this.replayGainMode = mode
      localStorage.setItem('player.replayGainMode', `${mode}`)
    },

    /** Toggle repeat and persist it. */
    toggleRepeat() {
      this.repeat = !this.repeat
      localStorage.setItem('player.repeat', String(this.repeat))
    },

    /** Toggle shuffle. */
    toggleShuffle() {
      this.setShuffle(!this.shuffle)
    },

    /** Set volume and persist it. */
    setVolume(volume: number) {
      audio.setVolume(volume)
      this.volume = volume
      localStorage.setItem('player.volume', String(volume))
    },

    /** Set shuffle and persist it. */
    setShuffle(toggle: boolean) {
      this.shuffle = toggle
      localStorage.setItem('player.shuffle', String(toggle))
    },

    /** Replace the queue and reset the index. */
    setQueue(queue: Track[]) {
      this.queue = queue
      this.queueIndex = -1
    },

    /** Continue with radio at queue end, or reset the queue on failure. */
    async processQueueEnd() {
      const track = this.track
      if (!track?.url) return
      this.inTransition = true
      try {
        const radioStore = useRadioStore()
        await radioStore.continueFromTrack(track)
      } catch {
        this.resetQueue()
      }
      this.inTransition = false
    },

    /** Set the queue index (wrap/clamp) and refresh track and media session metadata. */
    setQueueIndex(index: number) {
      if (!this.queue || this.queue.length === 0) {
        this.queueIndex = -1
        this.duration = 0
        this.setMediaSessionState('paused')
        return
      }
      index = Math.max(0, index)
      if (index >= this.queue.length) {
        if (this.repeat) {
          index = 0
        } else {
          this.queueIndex = this.queue.length - 1
          return
        }
      }
      this.queueIndex = index
      if (!this.track) return

      this.scrobbled = false
      this.duration = this.track.duration
      this.currentTime = 0

      const trackTitle = this.track.title || ''
      const trackArtist = formatArtists(this.track.artists) || ''
      const trackAlbum = this.track.album || ''
      const trackImage = this.track.image || null
      if (mediaSession) {
        const artwork: MediaImage[] = []
        if (trackImage) {
          artwork.push(
            { src: trackImage, sizes: '96x96', type: 'image/png' },
            { src: trackImage, sizes: '128x128', type: 'image/png' },
            { src: trackImage, sizes: '192x192', type: 'image/png' },
            { src: trackImage, sizes: '256x256', type: 'image/png' },
            { src: trackImage, sizes: '384x384', type: 'image/png' },
            { src: trackImage, sizes: '512x512', type: 'image/png' }
          )
        }
        navigator.mediaSession.metadata = new MediaMetadata({
          title: trackTitle,
          artist: trackArtist,
          album: trackAlbum,
          artwork
        })
      }
    },
  },
})

// ── setupAudio ───────────────────────────────────────────────────────────
/** Wire audio events, device handling, shortcuts and MediaSession to the store (called once at startup). */
export async function setupAudio(
  playerStore: ReturnType<typeof usePlayerStore>,
  mainStore: ReturnType<typeof useMainStore>
) {

  /** Pick the best supported codec. */
  function getCodec() {
    const audio = document.createElement('audio')

    if (audio.canPlayType('audio/ogg; codecs=opus') !== '' || audio.canPlayType('audio/webm; codecs=opus') !== '') {
      return 'opus'
    }
    if (audio.canPlayType('audio/aac') !== '') {
      return 'aac'
    }
    if (audio.canPlayType('audio/ogg') !== '') {
      return 'ogg'
    }
    return 'mp3'
  }

  const codec = getCodec()
  localStorage.setItem('audioCodec', codec)
  console.info('[audio] codec:', codec)

  // ── Playback events ─────────────────────────────────────────────────────
  let playTime = 0
  let pauseTime = 0

  // Error retry state
  let retryTimer: ReturnType<typeof setTimeout> | null = null // pending retry (3 s wait)
  let retriedTrackId: string | null = null // track for which a retry was already attempted

  /** Skip a broken track: next, else previous, else reset the queue. */
  const skipBrokenTrack = () => {
    if (playerStore.hasNext) {
      void playerStore.next(true)
    } else if (playerStore.hasPrevious) {
      void playerStore.back()
    } else {
      void playerStore.resetQueue()
    }
  }

  playerStore.setMediaSessionState('none')

  audio.onplay = async () => {
    console.info('[audio] play')
    playerStore.isPlaying = true
    playerStore.userPaused = false
    playTime = Date.now()
    await playerStore.setMediaSessionPosition()
    await playerStore.setMediaSessionState('playing')
  }

  audio.oncanplay = async () => {
    await sleep(300)
    if (playerStore.inTransition) return
    if (!playerStore.isPlaying && !playerStore.userPaused) await audio.play()
  }

  audio.onplaying = async () => {
    console.info('[audio] playing')
    retriedTrackId = null // playback works again: allow a future retry
    playerStore.isPlaying = true
    playerStore.userPaused = false
    playTime = Date.now()
    await playerStore.setMediaSessionPosition()
    await playerStore.setMediaSessionState('playing')
  }

  audio.onpause = async () => {
    console.info('[audio] pause')
    playerStore.isPlaying = false
    pauseTime = Date.now()
    await playerStore.setMediaSessionPosition()
    await playerStore.setMediaSessionState('paused')
  }

  // Next track, or queue end
  audio.onended = async () => {
    const { hasNext, repeat } = playerStore
    if (hasNext || repeat) {
      await playerStore.next(false)
    } else {
      await playerStore.processQueueEnd()
    }
  }

  // First error on a track: wait 3 s, then retry from the same position.
  // Second error on the same track: show the error and skip it.
  audio.onerror = (error: any) => {
    console.warn('[audio] error:', error)

    const track = playerStore.track
    if (!track) return
    if (retryTimer) return // a retry is already pending: ignore duplicate errors

    if (retriedTrackId !== track.id) {
      retriedTrackId = track.id
      const position = playerStore.currentTime
      console.info('[audio] retry in 3s')

      retryTimer = setTimeout(async () => {
        retryTimer = null
        // The user changed track while waiting: drop this retry
        if (playerStore.track?.id !== track.id) return

        playerStore.inTransition = true
        try {
          await audio.loadTrack({
            url: track.url,
            replayGain: track.replayGain,
            nextUrl: playerStore.nextTrack?.url,
            fade: false,
            paused: playerStore.userPaused
          })
          if (position > 0) await playerStore.seek(position)
        } catch (err) {
          console.warn('[audio] retry failed:', err)
          retriedTrackId = null
          mainStore.setError(err)
          skipBrokenTrack()
        } finally {
          playerStore.inTransition = false
        }
      }, 3000)
      return
    }

    // Retry already attempted for this track
    retriedTrackId = null
    mainStore.setError(error)
    skipBrokenTrack()
  }

  // Auto-resume when the page becomes visible
  document.addEventListener('visibilitychange', async () => {
    if (playerStore.isPlaying) return
    if (playerStore.userPaused) return
    if (document.visibilityState === 'visible') {
      console.info('[page] visible -> resume')
      await playerStore.play()
    }
  })

  // ── Output devices (Bluetooth, headphones…) ─────────────────────────────

  /** Snapshot of current audio device IDs (excluding virtual defaults). */
  const getDeviceIds = async (): Promise<Set<string>> => {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return new Set(
      devices
        .filter(d => d.kind === 'audiooutput' || d.kind === 'audioinput')
        .map(d => `${d.kind}:${d.deviceId}:${d.label}`)
        .filter(id => !id.includes(':default:') && !id.includes(':communications:'))
    )
  }

  let knownOutputs = await getDeviceIds()

  // Pause when a device is removed, play when one is added
  const onDeviceChange = throttle(async () => {
    console.info('[devices] change')
    if (playerStore.userPaused) return
    const current = await getDeviceIds()
    const added = [...current].some(id => !knownOutputs.has(id))
    const removed = [...knownOutputs].some(id => !current.has(id))
    knownOutputs = current

    if (removed && Date.now() - playTime > 1000) {
      console.info('[devices] output removed -> pause')
      await audio.pause()
    } else if (added && Date.now() - pauseTime > 1000) {
      console.info('[devices] output added -> play')
      await playerStore.play()
    }
  }, 500, { leading: false, trailing: true })

  navigator.mediaDevices.addEventListener('devicechange', onDeviceChange)

  // ── Microphone permission (exposes device labels) ───────────────────────

  /** Request mic permission, then release the stream. */
  const requestMicAccess = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach(t => t.stop())
      knownOutputs = await getDeviceIds() // re-baseline now that IDs are exposed
      console.info('[devices] mic permission granted')
    } catch (err) {
      console.warn('[devices] mic permission unavailable:', err)
    }
  }

  /** Ask for mic permission on the first user gesture, if not already decided. */
  const ensureMicAccess = async () => {
    let state: PermissionState = 'prompt'
    try {
      state = (await navigator.permissions.query({ name: 'microphone' as PermissionName })).state
    } catch {
      // Not supported (e.g. Safari)
    }
    if (state === 'granted') {
      knownOutputs = await getDeviceIds()
      return
    }
    if (state === 'denied') return

    const onGesture = () => {
      window.removeEventListener('pointerdown', onGesture, true)
      window.removeEventListener('keydown', onGesture, true)
      void requestMicAccess()
    }
    window.addEventListener('pointerdown', onGesture, true)
    window.addEventListener('keydown', onGesture, true)
  }

  void ensureMicAccess()

  // ── Desktop keyboard shortcuts ──────────────────────────────────────────
  if (!isMobile) {
    window.addEventListener('keydown', async (event) => {
      const target = event.target as HTMLElement | null
      if (
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable
      ) {
        return
      }

      if (event.code === 'Space') {
        event.preventDefault()
        await playerStore.playPause()
      } else if (event.code === 'ArrowLeft') {
        event.preventDefault()
        await playerStore.back()
      } else if (event.code === 'ArrowRight') {
        event.preventDefault()
        await playerStore.next(true)
      }
    })
  }

  // ── Time updates: save, auto-skip, scrobble ─────────────────────────────
  let saveTime = 0
  audio.ontimeupdate = (time: number) => {
    if (playerStore.inTransition) return
    playerStore.currentTime = time

    const track = playerStore.track
    const isPlaying = playerStore.isPlaying

    // Save the queue every 10s
    const now = Date.now()
    if (now - saveTime > 10000) {
      saveTime = now
      playerStore.saveQueue()
    }

    // Skip the first 20s to avoid false triggers on seek/slow loads
    if (!track || !isPlaying || time < 20) return

    const duration = playerStore.duration

    // Gapless: switch just before the end
    const remaining = duration - time
    if (remaining < 0.15 && playerStore.hasNext) {
      playerStore.next(false)
      return
    }

    // Scrobble past 50%
    const progress = duration ? time / duration : 0
    if (!playerStore.scrobbled && progress > 0.5 && track && isPlaying) {
      playerStore.scrobbled = true
      playerStore.api.scrobble(track.id)
    }
  }

  audio.ondurationchange = (duration: number) => {
    playerStore.duration = duration
    playerStore.setMediaSessionPosition()
  }

  // ── Page lifecycle ──────────────────────────────────────────────────────

  // Save the queue on unload; confirm if playing
  window.addEventListener('beforeunload', (event) => {
    playerStore.saveQueue()

    if (playerStore.isPlaying) {
      event.preventDefault()
      event.returnValue = ''
      return ''
    }
  })

  // ── Initial audio settings ──────────────────────────────────────────────
  audio.setReplayGainMode(storedReplayGainMode)
  audio.setVolume(playerStore.volume)

  // ── MediaSession handlers (lock screen, headset buttons…) ───────────────
  if (mediaSession) {
    mediaSession.setActionHandler('play', () => { console.info('[mediasession] play'); playerStore.play() })
    mediaSession.setActionHandler('pause', () => { console.info('[mediasession] pause'); playerStore.pause() })
    mediaSession.setActionHandler('nexttrack', () => { console.info('[mediasession] nexttrack'); playerStore.next(true) })
    mediaSession.setActionHandler('previoustrack', () => { console.info('[mediasession] previoustrack'); playerStore.back() })
    mediaSession.setActionHandler('stop', () => { console.info('[mediasession] stop'); playerStore.pause() })
    mediaSession.setActionHandler('seekto', async (details) => {
      // Ignore fastSeek (scrubbing in progress)
      if (details.fastSeek || details.seekTime === undefined) return
      const position = Math.min(details.seekTime, playerStore.duration)
      playerStore.seek(position)
    })
    mediaSession.setActionHandler('seekforward', (details) => {
      const offset = details.seekOffset || 10
      const position = Math.min(playerStore.currentTime + offset, playerStore.duration)
      playerStore.seek(position)
    })
    mediaSession.setActionHandler('seekbackward', (details) => {
      const offset = details.seekOffset || 10
      const position = Math.max(playerStore.currentTime - offset, 0)
      playerStore.seek(position)
    })
  }

  // Restore the last session's queue (paused)
  await playerStore.loadQueue()
}
