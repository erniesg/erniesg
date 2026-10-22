import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'

type Phase = 'entrance' | 'emotional' | 'exit'

type BluetoothCharacteristic = EventTarget & {
  startNotifications: () => Promise<BluetoothCharacteristic>
}

type BluetoothNavigator = Navigator & {
  bluetooth?: {
    requestDevice: (options: {
      filters: Array<{ services: string[] }>
    }) => Promise<{
      gatt?: {
        connect: () => Promise<{
          getPrimaryService: (service: string) => Promise<{
            getCharacteristic: (
              characteristic: string,
            ) => Promise<BluetoothCharacteristic>
          }>
        }>
      }
    }>
  }
}

const PHASES: Array<{ id: Phase; number: string; label: string; note: string }> = [
  {
    id: 'entrance',
    number: 'I',
    label: 'Entrance',
    note: 'A sparse rhythm makes the connection legible.',
  },
  {
    id: 'emotional',
    number: 'II',
    label: 'Emotional',
    note: 'The letter appears as the pattern gains intensity.',
  },
  {
    id: 'exit',
    number: 'III',
    label: 'Exit',
    note: 'The rhythm thins, leaving space for reflection.',
  },
]

export function mappedTempo(heartRate: number) {
  const boundedHeartRate = Math.min(120, Math.max(60, heartRate))
  return Math.round(65 + ((boundedHeartRate - 60) / 60) * 30)
}

function readHeartRate(value: DataView) {
  const flags = value.getUint8(0)
  return flags & 0x01 ? value.getUint16(1, true) : value.getUint8(1)
}

export default function HeartLettersPrototype() {
  const [heartRate, setHeartRate] = useState(72)
  const [phase, setPhase] = useState<Phase>('entrance')
  const [playing, setPlaying] = useState(false)
  const [connection, setConnection] = useState('Manual pulse')
  const audioContext = useRef<AudioContext>()
  const beatTimer = useRef<number>()
  const beatIndex = useRef(0)
  const tempo = mappedTempo(heartRate)
  const phaseInfo = PHASES.find((item) => item.id === phase) ?? PHASES[0]
  const bluetoothAvailable =
    typeof navigator !== 'undefined' &&
    Boolean((navigator as BluetoothNavigator).bluetooth)

  const visualStyle = useMemo(
    () =>
      ({
        '--heartbeat-duration': `${60 / Math.max(heartRate, 1)}s`,
        '--letter-reveal': phase === 'entrance' ? 0.46 : phase === 'exit' ? 0.62 : 0.92,
      }) as CSSProperties,
    [heartRate, phase],
  )

  const strike = (context: AudioContext, index: number) => {
    const now = context.currentTime
    const phaseGain = phase === 'entrance' ? 0.08 : phase === 'emotional' ? 0.16 : 0.055
    const accent = phase === 'emotional' && index % 4 === 0
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.type = accent ? 'triangle' : 'sine'
    oscillator.frequency.setValueAtTime(accent ? 164 : 92, now)
    oscillator.frequency.exponentialRampToValueAtTime(48, now + 0.11)
    gain.gain.setValueAtTime(phaseGain * (accent ? 1.55 : 1), now)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + (accent ? 0.32 : 0.18))
    oscillator.connect(gain).connect(context.destination)
    oscillator.start(now)
    oscillator.stop(now + 0.35)
  }

  useEffect(() => {
    if (!playing) return
    const context = audioContext.current
    if (!context) return

    const playBeat = () => {
      strike(context, beatIndex.current)
      beatIndex.current += 1
    }
    playBeat()
    beatTimer.current = window.setInterval(playBeat, (60 / tempo) * 1000)
    return () => {
      if (beatTimer.current) window.clearInterval(beatTimer.current)
    }
  }, [phase, playing, tempo])

  useEffect(
    () => () => {
      if (beatTimer.current) window.clearInterval(beatTimer.current)
      void audioContext.current?.close()
    },
    [],
  )

  const toggleSound = async () => {
    if (playing) {
      setPlaying(false)
      return
    }
    if (!audioContext.current || audioContext.current.state === 'closed') {
      audioContext.current = new AudioContext()
    }
    await audioContext.current.resume()
    setPlaying(true)
  }

  const connectHeartRate = async () => {
    const bluetooth = (navigator as BluetoothNavigator).bluetooth
    if (!bluetooth) return
    try {
      setConnection('Connecting…')
      const device = await bluetooth.requestDevice({
        filters: [{ services: ['heart_rate'] }],
      })
      const server = await device.gatt?.connect()
      if (!server) throw new Error('Heart-rate service unavailable')
      const service = await server.getPrimaryService('heart_rate')
      const characteristic = await service.getCharacteristic(
        'heart_rate_measurement',
      )
      await characteristic.startNotifications()
      characteristic.addEventListener('characteristicvaluechanged', (event) => {
        const value = (event.target as EventTarget & { value?: DataView }).value
        if (!value) return
        const next = readHeartRate(value)
        if (next >= 35 && next <= 220) setHeartRate(next)
      })
      setConnection('Live heart rate')
    } catch (error) {
      setConnection(
        error instanceof Error && error.name === 'NotFoundError'
          ? 'Connection cancelled'
          : 'Could not connect',
      )
    }
  }

  return (
    <section className="heart-prototype" aria-labelledby="prototype-title">
      <header className="heart-prototype__intro">
        <div>
          <p>Browser prototype · study 01</p>
          <h2 id="prototype-title">Listen with your pulse.</h2>
        </div>
        <p>
          A small, functional sketch of the installation: heart rate is mapped
          from 60–120 BPM to a 65–95 BPM percussion tempo. Sound begins only
          when you ask it to.
        </p>
      </header>

      <div className="heart-prototype__stage" style={visualStyle}>
        <div className="heart-prototype__letter" aria-hidden="true">
          <img
            src="/research/if-letters-home-could-sing/media/image3.jpg"
            alt=""
          />
          <div className="heart-prototype__pulse">
            <i />
            <i />
            <i />
          </div>
          <span>{heartRate}</span>
          <small>heart / min</small>
        </div>

        <div className="heart-prototype__controls">
          <div className="heart-prototype__reading" aria-live="polite">
            <span>Body</span>
            <strong>{heartRate} BPM</strong>
            <span>Sound</span>
            <strong>{tempo} BPM</strong>
          </div>

          <label className="heart-prototype__range">
            <span>Set a resting pulse</span>
            <input
              type="range"
              min="60"
              max="120"
              value={heartRate}
              onChange={(event) => {
                setHeartRate(Number(event.target.value))
                setConnection('Manual pulse')
              }}
            />
            <span aria-hidden="true">60</span>
            <span aria-hidden="true">120</span>
          </label>

          <div className="heart-prototype__phases" aria-label="Narrative phase">
            {PHASES.map((item) => (
              <button
                key={item.id}
                className={phase === item.id ? 'is-active' : ''}
                onClick={() => setPhase(item.id)}
                aria-pressed={phase === item.id}
              >
                <span>{item.number}</span>
                {item.label}
              </button>
            ))}
          </div>
          <p className="heart-prototype__phase-note">{phaseInfo.note}</p>

          <div className="heart-prototype__actions">
            <button className="heart-prototype__listen" onClick={toggleSound}>
              <span aria-hidden="true">{playing ? 'Ⅱ' : '▶'}</span>
              {playing ? 'Pause percussion' : 'Hear the pulse'}
            </button>
            <button
              className="heart-prototype__connect"
              onClick={connectHeartRate}
              disabled={!bluetoothAvailable}
              title={
                bluetoothAvailable
                  ? 'Connect a Bluetooth heart-rate monitor'
                  : 'Web Bluetooth is available in supported Chromium browsers'
              }
            >
              {bluetoothAvailable ? 'Connect monitor' : 'Bluetooth unavailable'}
            </button>
          </div>
          <small className="heart-prototype__connection">{connection}</small>
        </div>
      </div>

      <footer>
        The tones are browser-synthesised for this study and are not archival
        recordings. The published research proposes a fuller percussion system
        using Bangu, Daluo, Xiaoluo, and Naobo patterns.
      </footer>
    </section>
  )
}
