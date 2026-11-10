import { useContext, useRef } from 'preact/hooks'
import { setFlag, setText, useFrame } from '../../parts/frames'
import { meterPosition, peakText } from '../../parts/levels'
import { MeterBoardContext, masterMeter, type Side } from '../../parts/meter-board'

/** Segments of a side lit by the level, in equal steps of the meter's scale: five green, then two yellow. */
const levelSegments = 7

/** How far back the number looks for the loudest peak, in ms. */
const peakHoldMs = 2000

const sides: ReadonlyArray<Side> = [0, 1]

/** Of a side's segments, how many its level lights: none at the floor, all at full scale. */
export const litSegments = (peak: number) => Math.ceil(meterPosition(peak) * levelSegments)

/** The engine's output as the Mixer's master shows it: segments, a lamp latched on overs, the last 2 s' loudest peak. */
export const MasterMeter = () => {
  const board = useContext(MeterBoardContext)
  const segments = useRef<Array<Array<HTMLSpanElement | null>>>([[], []])
  const lamps = useRef<Array<HTMLSpanElement | null>>([])
  const peak = useRef<HTMLSpanElement>(null)
  const peaks = useRef<ReadonlyArray<{ readonly peak: number; readonly at: number }>>([])
  useFrame((frame) => {
    // Drawn on every page, the board follows the Mixer's strips too, so their lamps latch while it's away.
    board.follow(frame)
    sides.forEach((side) => {
      const lit = litSegments(board.level(masterMeter, side))
      segments.current[side].forEach((segment, i) => setFlag(segment, 'data-on', i < lit))
      setFlag(lamps.current[side], 'data-lit', board.lit(masterMeter, side))
    })
    const now = performance.now()
    const loudest = Math.max(board.level(masterMeter, 0), board.level(masterMeter, 1))
    // The last two seconds' peaks no later one tops, loudest first; with no frame, no engine and none.
    peaks.current = [
      ...peaks.current.filter(({ peak, at }) => frame !== undefined && now - at < peakHoldMs && peak > loudest),
      { peak: loudest, at: now }
    ]
    setText(peak.current, peakText(peaks.current[0]?.peak ?? 0))
  })
  return (
    <button
      type='button'
      class='field field--readout master'
      aria-label='Master level'
      data-hint="Master: the engine's output, left over right. The red lamp latches on a peak over full scale; click to put both out. The number is the loudest peak of the last two seconds"
      onClick={() =>
        sides.forEach((side) => {
          board.putOut(masterMeter, side)
          setFlag(lamps.current[side], 'data-lit', false)
        })
      }
    >
      <span class='field__name'>MASTER</span>
      <span class='master__sides'>
        {sides.map((side) => (
          <span class='master__side' key={side}>
            {Array.from({ length: levelSegments }, (_, i) => (
              <span
                class='master__segment'
                key={i}
                ref={(segment) => {
                  segments.current[side][i] = segment
                }}
              />
            ))}
            <span
              class='master__lamp'
              ref={(lamp) => {
                lamps.current[side] = lamp
              }}
            />
          </span>
        ))}
      </span>
      <span class='field__name master__peak' ref={peak}>
        −∞ dB
      </span>
    </button>
  )
}
