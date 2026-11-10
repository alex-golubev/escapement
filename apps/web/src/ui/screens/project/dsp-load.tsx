import { useAtomValue } from '@effect/atom-react'
import { Number, Option } from 'effect'
import { useRef } from 'preact/hooks'
import type { Measuring } from '../../../services/engine-host'
import { useCore } from '../../core-context'
import { setFlag, setStyleVar, setText, useFrame } from '../../parts/frames'

/** Of a block's time, what the longest block may take before the sound is near breaking. */
const nearBreaking = 0.9

const hints: Record<Measuring, string> = {
  on: "DSP load: the share of each block's time this tab's sound engine takes, measured a tenth of every second; red once a block took 90% of it or the sound broke. Click to stop measuring",
  waiting: 'DSP load: measured while it plays and the page is in sight. Click to stop measuring',
  off: 'DSP load: not measured. Click to measure it: a thread keeps a core busy a tenth of every second while it plays',
  'few-cores': 'DSP load: not measured on 4 cores or fewer, where its clock would take a core from the sound'
}

/** The engine's load in its last burst measured, written into the DOM on every frame; a click switches measuring. */
export const DspLoadMeter = () => {
  const { host, run } = useCore()
  const measuring = useAtomValue(host.measuring)
  const meter = useRef<HTMLButtonElement>(null)
  const fill = useRef<HTMLSpanElement>(null)
  const value = useRef<HTMLSpanElement>(null)
  useFrame((frame) => {
    const load = Option.filter(Option.fromUndefinedOr(frame?.dspLoad), () => measuring === 'on')
    const share = Option.getOrElse(
      Option.map(load, (measured) => measured.share),
      () => 0
    )
    setStyleVar(fill.current, '--share', Number.clamp(share, { minimum: 0, maximum: 1 }).toFixed(3))
    setText(value.current, Option.match(load, { onNone: () => '—', onSome: () => `${(share * 100).toFixed(1)}%` }))
    setFlag(
      meter.current,
      'data-alarm',
      Option.exists(load, ({ longest, broke }) => longest > nearBreaking || broke)
    )
  })
  return (
    <button
      type='button'
      class='dsp-load'
      ref={meter}
      aria-label='DSP load'
      aria-pressed={measuring === 'on' || measuring === 'waiting'}
      disabled={measuring === 'few-cores'}
      data-hint={hints[measuring]}
      onClick={() => run(host.toggleMeasuring)}
    >
      <span class='dsp-load__name'>DSP LOAD:</span>
      <span class='dsp-load__bar'>
        <span class='dsp-load__fill' ref={fill} />
      </span>
      <span class='dsp-load__value' ref={value}>
        —
      </span>
    </button>
  )
}
