import { Option } from 'effect'
import { useEffect, useState } from 'preact/hooks'
import './hint-line.css'

const idle = 'Point at a control: this line says what it is and whose it is'

/** The control `target` is in that has a hint, if any. */
const hinted = (target: EventTarget | null) =>
  Option.flatMap(
    Option.liftPredicate(target, (node): node is Element => node instanceof Element),
    (element) => Option.fromNullishOr(element.closest('[data-hint]'))
  )

/** The control if it is still on the page: one taken out sends no event as it goes. */
const present = (control: Option.Option<Element>) => Option.filter(control, (element) => element.isConnected)

/**
 * What the control under the pointer is and whose, or, with the pointer on none, the one with the focus; read from
 * its `data-hint`, again whenever the page changes, as after a click that turns a step on, or one that takes the
 * control away.
 */
export const HintLine = () => {
  const [text, setText] = useState(idle)
  useEffect(() => {
    const at = { pointed: Option.none<Element>(), focused: Option.none<Element>() }
    const show = () => {
      at.pointed = present(at.pointed)
      at.focused = present(at.focused)
      setText(
        Option.match(
          Option.orElse(at.pointed, () => at.focused),
          { onNone: () => idle, onSome: (control) => control.getAttribute('data-hint') ?? idle }
        )
      )
    }
    const changes = new MutationObserver(show)
    changes.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-hint'] })
    const onPointerOver = ({ target }: PointerEvent) => {
      at.pointed = hinted(target)
      show()
    }
    // Out of the window: over nothing of the page's.
    const onPointerOut = ({ relatedTarget }: PointerEvent) =>
      Option.match(Option.fromNullishOr(relatedTarget), {
        onNone: () => {
          at.pointed = Option.none()
          show()
        },
        onSome: () => {}
      })
    const onFocusIn = ({ target }: FocusEvent) => {
      at.focused = hinted(target)
      show()
    }
    const onFocusOut = () => {
      at.focused = Option.none()
      show()
    }
    document.addEventListener('pointerover', onPointerOver)
    document.addEventListener('pointerout', onPointerOut)
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('focusout', onFocusOut)
    return () => {
      changes.disconnect()
      document.removeEventListener('pointerover', onPointerOver)
      document.removeEventListener('pointerout', onPointerOut)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
    }
  }, [])
  return <div class='hint'>{text}</div>
}
